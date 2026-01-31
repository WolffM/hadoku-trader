/**
 * Politician Rankings Computation
 *
 * Computes and stores politician performance rankings with a rolling window.
 * Used to generate dynamic Top N politician filters for trading agents.
 */

import type { TraderEnv } from "../types";
import { daysBetween } from "./filters";

// =============================================================================
// Types
// =============================================================================

export interface PoliticianRanking {
  politician_name: string;
  politician_party: string | null;
  politician_chamber: string | null;
  window_months: number;
  total_trades: number;
  closed_trades: number;
  total_return_pct: number;
  annualized_return_pct: number;
  avg_hold_days: number | null;
  rank: number | null;
  computed_at: string;
}

export interface ComputeRankingsOptions {
  windowMonths?: number;  // Default 24 (2 years)
  minTrades?: number;     // Minimum trades to qualify for ranking, default 15
}

export interface ComputeRankingsResult {
  success: boolean;
  computed_at: string;
  total_politicians: number;
  qualified_politicians: number;
  top_10: PoliticianRanking[];
}

interface SignalRow {
  id: string;
  ticker: string;
  action: string;
  politician_name: string;
  politician_party: string | null;
  politician_chamber: string | null;
  trade_date: string;
  trade_price: number;
  disclosure_date: string;
  position_size_min: number;
}

interface PositionForCalc {
  ticker: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  cost: number;
}

interface ClosedTradeForCalc {
  returnPct: number;
  holdDays: number;
  profit: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

function annualizeReturn(returnPct: number, holdDays: number): number {
  if (holdDays <= 0) return 0;
  const r = returnPct / 100;
  const years = holdDays / 365;
  if (years < 0.1) return returnPct;
  const annualized = Math.pow(1 + r, 1 / years) - 1;
  return annualized * 100;
}

function calculatePoliticianStatsFromSignals(
  signals: SignalRow[],
  politicianName: string
): {
  party: string | null;
  chamber: string | null;
  trades: number;
  closedTrades: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  avgHoldDays: number | null;
} | null {
  const politicianSignals = signals.filter(s => s.politician_name === politicianName);
  if (politicianSignals.length === 0) return null;

  const first = politicianSignals[0];

  // Group by ticker
  const tickerSignals = new Map<string, SignalRow[]>();
  for (const signal of politicianSignals) {
    if (!tickerSignals.has(signal.ticker)) {
      tickerSignals.set(signal.ticker, []);
    }
    tickerSignals.get(signal.ticker)!.push(signal);
  }

  const closedTrades: ClosedTradeForCalc[] = [];

  for (const [, tickerSigs] of tickerSignals) {
    const sorted = tickerSigs.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    const positionQueue: PositionForCalc[] = [];

    for (const signal of sorted) {
      if (signal.action === "buy") {
        const shares = signal.position_size_min / signal.trade_price;
        positionQueue.push({
          ticker: signal.ticker,
          shares,
          entryPrice: signal.trade_price,
          entryDate: signal.trade_date,
          cost: signal.position_size_min,
        });
      } else if (signal.action === "sell") {
        if (positionQueue.length > 0) {
          const position = positionQueue.shift()!;
          const exitPrice = signal.trade_price;
          const profit = (exitPrice - position.entryPrice) * position.shares;
          const returnPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
          const holdDays = daysBetween(position.entryDate, signal.trade_date);

          closedTrades.push({
            returnPct,
            holdDays: Math.max(0, holdDays),
            profit,
          });
        }
      }
    }
  }

  const buySignals = politicianSignals.filter(s => s.action === "buy");
  if (buySignals.length === 0) return null;

  // Calculate stats from closed trades only (no unrealized)
  const totalCost = closedTrades.reduce((sum, t) => {
    // Approximate cost from return and profit
    // profit = (exit - entry) * shares
    // returnPct = ((exit - entry) / entry) * 100
    // So cost = profit / (returnPct / 100) if returnPct != 0
    if (t.returnPct === 0) return sum;
    return sum + Math.abs(t.profit / (t.returnPct / 100));
  }, 0);

  const totalProfit = closedTrades.reduce((sum, t) => sum + t.profit, 0);
  const totalReturnPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;

  const avgHoldDays = closedTrades.length > 0
    ? closedTrades.reduce((sum, t) => sum + t.holdDays, 0) / closedTrades.length
    : null;

  const annualizedReturnPct = avgHoldDays && avgHoldDays > 0
    ? annualizeReturn(totalReturnPct, avgHoldDays)
    : totalReturnPct;

  return {
    party: first.politician_party,
    chamber: first.politician_chamber,
    trades: buySignals.length,
    closedTrades: closedTrades.length,
    totalReturnPct,
    annualizedReturnPct,
    avgHoldDays,
  };
}

// =============================================================================
// Main Computation Function
// =============================================================================

/**
 * Compute politician rankings from signal history and store in D1.
 *
 * @param env - Cloudflare Worker environment with TRADER_DB binding
 * @param options - Computation options (window, min trades)
 * @returns Result with top 10 rankings
 */
export async function computePoliticianRankings(
  env: TraderEnv,
  options: ComputeRankingsOptions = {}
): Promise<ComputeRankingsResult> {
  const windowMonths = options.windowMonths ?? 24;
  const minTrades = options.minTrades ?? 15;
  const computedAt = new Date().toISOString();

  // Calculate window start date
  const windowStart = new Date();
  windowStart.setMonth(windowStart.getMonth() - windowMonths);
  const windowStartStr = windowStart.toISOString().split("T")[0];

  // Fetch all signals within the window
  const signalsResult = await env.TRADER_DB.prepare(`
    SELECT
      id,
      ticker,
      action,
      politician_name,
      politician_party,
      politician_chamber,
      trade_date,
      trade_price,
      disclosure_date,
      position_size_min
    FROM signals
    WHERE trade_date >= ?
      AND trade_price > 0
      AND position_size_min > 0
    ORDER BY trade_date ASC
  `).bind(windowStartStr).all<SignalRow>();

  const signals = signalsResult.results ?? [];

  // Get unique politicians
  const politicianNames = [...new Set(signals.map(s => s.politician_name))];

  // Calculate stats for each politician
  const allStats: PoliticianRanking[] = [];

  for (const name of politicianNames) {
    const stats = calculatePoliticianStatsFromSignals(signals, name);
    if (stats) {
      allStats.push({
        politician_name: name,
        politician_party: stats.party,
        politician_chamber: stats.chamber,
        window_months: windowMonths,
        total_trades: stats.trades,
        closed_trades: stats.closedTrades,
        total_return_pct: stats.totalReturnPct,
        annualized_return_pct: stats.annualizedReturnPct,
        avg_hold_days: stats.avgHoldDays,
        rank: null,
        computed_at: computedAt,
      });
    }
  }

  // Filter by min trades and sort by annualized return
  const qualified = allStats
    .filter(p => p.total_trades >= minTrades)
    .sort((a, b) => b.annualized_return_pct - a.annualized_return_pct);

  // Assign ranks
  qualified.forEach((p, i) => {
    p.rank = i + 1;
  });

  // Also keep unqualified politicians but without rank
  const unqualified = allStats.filter(p => p.total_trades < minTrades);

  // Clear existing rankings and insert new ones
  await env.TRADER_DB.prepare(`DELETE FROM politician_rankings`).run();

  // Insert all rankings (batch insert)
  const allRankings = [...qualified, ...unqualified];

  for (const ranking of allRankings) {
    await env.TRADER_DB.prepare(`
      INSERT INTO politician_rankings (
        politician_name,
        politician_party,
        politician_chamber,
        window_months,
        total_trades,
        closed_trades,
        total_return_pct,
        annualized_return_pct,
        avg_hold_days,
        rank,
        computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      ranking.politician_name,
      ranking.politician_party,
      ranking.politician_chamber,
      ranking.window_months,
      ranking.total_trades,
      ranking.closed_trades,
      ranking.total_return_pct,
      ranking.annualized_return_pct,
      ranking.avg_hold_days,
      ranking.rank,
      ranking.computed_at
    ).run();
  }

  return {
    success: true,
    computed_at: computedAt,
    total_politicians: allStats.length,
    qualified_politicians: qualified.length,
    top_10: qualified.slice(0, 10),
  };
}

/**
 * Get current top N politicians from the rankings table.
 * Does not recompute - returns cached rankings.
 */
export async function getTopPoliticians(
  env: TraderEnv,
  n: number = 10
): Promise<string[]> {
  const results = await env.TRADER_DB.prepare(`
    SELECT politician_name FROM politician_rankings
    WHERE rank IS NOT NULL AND rank <= ?
    ORDER BY rank ASC
  `).bind(n).all<{ politician_name: string }>();

  return (results.results ?? []).map(r => r.politician_name);
}

/**
 * Get full rankings from the table.
 */
export async function getPoliticianRankings(
  env: TraderEnv,
  limit: number = 50
): Promise<PoliticianRanking[]> {
  const results = await env.TRADER_DB.prepare(`
    SELECT * FROM politician_rankings
    ORDER BY
      CASE WHEN rank IS NULL THEN 1 ELSE 0 END,
      rank ASC,
      annualized_return_pct DESC
    LIMIT ?
  `).bind(limit).all<PoliticianRanking>();

  return results.results ?? [];
}
