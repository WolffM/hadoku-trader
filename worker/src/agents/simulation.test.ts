/**
 * Portfolio Simulation Test
 *
 * Run with: cd worker && pnpm test simulation
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG, NAIVE_CONFIG } from "./configs";
import { runSimulation, type SimSignal, calculateHistoricalBucketStats, calculateBucketSizes, getBucket } from "./simulation";
import { calculateScoreSync } from "./scoring";

// =============================================================================
// Load Data
// =============================================================================

interface Signal {
  id: string;
  source: string;
  politician_name: string;
  politician_chamber: "house" | "senate";
  politician_party: "D" | "R";
  politician_state: string;
  ticker: string;
  action: "buy" | "sell";
  asset_type: string;
  position_size_min: number;
  trade_date: string;
  trade_price: number;
  disclosure_date: string;
  disclosure_price: number | null;
}

function loadSignals(): SimSignal[] {
  const dbPath = path.join(__dirname, "../../../trader-db-export.json");
  const db = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  return db.signals;
}

function loadSignalsTyped(): Signal[] {
  const dbPath = path.join(__dirname, "../../../trader-db-export.json");
  const db = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  return db.signals.filter((s: Signal) =>
    s.ticker &&
    s.trade_date &&
    s.trade_price > 0 &&
    s.action &&
    s.politician_name &&
    s.politician_party &&
    s.politician_chamber
  );
}

// =============================================================================
// Politician Performance Calculator (from politician-analysis.test.ts)
// =============================================================================

function daysBetween(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
}

function annualizeReturn(returnPct: number, holdDays: number): number {
  if (holdDays <= 0) return 0;
  const r = returnPct / 100;
  const years = holdDays / 365;
  if (years < 0.1) return returnPct;
  const annualized = Math.pow(1 + r, 1 / years) - 1;
  return annualized * 100;
}

interface PoliticianStats {
  name: string;
  party: "D" | "R";
  trades: number;
  closedTrades: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  avgHoldDays: number;
}

function buildPriceMap(signals: Signal[]): Map<string, { price: number; date: string }> {
  const priceMap = new Map<string, { price: number; date: string }>();
  for (const signal of signals) {
    const ticker = signal.ticker;
    const existing = priceMap.get(ticker);
    const price = signal.disclosure_price ?? signal.trade_price;
    const date = signal.disclosure_date;
    if (!existing || date > existing.date) {
      if (price > 0) {
        priceMap.set(ticker, { price, date });
      }
    }
  }
  return priceMap;
}

interface Position {
  ticker: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  cost: number;
  currentPrice?: number;
  currentValue?: number;
  unrealizedPnL?: number;
}

interface ClosedTrade {
  ticker: string;
  shares: number;
  entryPrice: number;
  exitPrice: number;
  entryDate: string;
  exitDate: string;
  returnPct: number;
  holdDays: number;
  profit: number;
}

function calculatePoliticianStats(
  signals: Signal[],
  politicianName: string,
  priceMap: Map<string, { price: number; date: string }>
): PoliticianStats | null {
  const politicianSignals = signals.filter(s => s.politician_name === politicianName);
  if (politicianSignals.length === 0) return null;

  const first = politicianSignals[0];

  // Group by ticker
  const tickerSignals = new Map<string, Signal[]>();
  for (const signal of politicianSignals) {
    if (!tickerSignals.has(signal.ticker)) {
      tickerSignals.set(signal.ticker, []);
    }
    tickerSignals.get(signal.ticker)!.push(signal);
  }

  const closedTrades: ClosedTrade[] = [];
  const openPositions: Position[] = [];

  for (const [ticker, tickerSigs] of tickerSignals) {
    const sorted = tickerSigs.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    const positionQueue: Position[] = [];

    for (const signal of sorted) {
      if (signal.action === "buy") {
        const shares = signal.position_size_min / signal.trade_price;
        positionQueue.push({
          ticker,
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
            ticker,
            shares: position.shares,
            entryPrice: position.entryPrice,
            exitPrice,
            entryDate: position.entryDate,
            exitDate: signal.trade_date,
            returnPct,
            holdDays: Math.max(0, holdDays),
            profit,
          });
        }
      }
    }

    for (const position of positionQueue) {
      const latestPrice = priceMap.get(position.ticker);
      if (latestPrice) {
        position.currentPrice = latestPrice.price;
        position.currentValue = position.shares * latestPrice.price;
        position.unrealizedPnL = position.currentValue - position.cost;
      }
    }
    openPositions.push(...positionQueue);
  }

  if (closedTrades.length === 0 && openPositions.length === 0) {
    return null;
  }

  const totalCostOfClosed = closedTrades.reduce((sum, t) => sum + (t.shares * t.entryPrice), 0);
  const realizedPnL = closedTrades.reduce((sum, t) => sum + t.profit, 0);

  const openWithPrices = openPositions.filter(p => p.currentPrice !== undefined);
  const unrealizedCost = openWithPrices.reduce((sum, p) => sum + p.cost, 0);
  const unrealizedPnL = openWithPrices.reduce((sum, p) => sum + (p.unrealizedPnL ?? 0), 0);

  const totalCostWithPrices = totalCostOfClosed + unrealizedCost;
  const totalPnL = realizedPnL + unrealizedPnL;
  const totalReturnPct = totalCostWithPrices > 0 ? (totalPnL / totalCostWithPrices) * 100 : 0;

  const avgHoldDays = closedTrades.length > 0
    ? closedTrades.reduce((sum, t) => sum + t.holdDays, 0) / closedTrades.length
    : 0;

  const buySignals = politicianSignals.filter(s => s.action === "buy");
  const annualizedReturnPct = avgHoldDays > 0
    ? annualizeReturn(totalReturnPct, avgHoldDays)
    : totalReturnPct;

  return {
    name: politicianName,
    party: first.politician_party,
    trades: buySignals.length,
    closedTrades: closedTrades.length,
    totalReturnPct,
    annualizedReturnPct,
    avgHoldDays,
  };
}

// =============================================================================
// Build Politician Filters
// =============================================================================

interface PoliticianFilter {
  name: string;
  politicians: Set<string>;
  signalsPerMonth: number;
}

function buildPoliticianFilters(signals: Signal[]): PoliticianFilter[] {
  const priceMap = buildPriceMap(signals);
  const politicianNames = [...new Set(signals.map(s => s.politician_name))];

  // Calculate stats for all politicians
  const allStats: PoliticianStats[] = [];
  for (const name of politicianNames) {
    const stats = calculatePoliticianStats(signals, name, priceMap);
    if (stats && (stats.closedTrades > 0 || stats.trades > 0)) {
      allStats.push(stats);
    }
  }

  // Get qualified politicians (min 15 trades) sorted by annualized return
  const MIN_TRADES = 15;
  const qualified = [...allStats]
    .filter(p => p.trades >= MIN_TRADES)
    .sort((a, b) => b.annualizedReturnPct - a.annualizedReturnPct);

  // Calculate date range for signals/month
  const buySignals = signals.filter(s => s.action === "buy" && s.trade_price > 0);
  const dates = buySignals.map(s => new Date(s.disclosure_date).getTime());
  const minDate = new Date(Math.min(...dates));
  const maxDate = new Date(Math.max(...dates));
  const totalMonths = (maxDate.getFullYear() - minDate.getFullYear()) * 12 +
                      (maxDate.getMonth() - minDate.getMonth()) + 1;

  // Helper to count signals per month for a filter
  const calcSignalsPerMonth = (politicianSet: Set<string>): number => {
    const filteredSignals = buySignals.filter(s => politicianSet.has(s.politician_name));
    return filteredSignals.length / totalMonths;
  };

  // Build the 5 filters
  const filters: PoliticianFilter[] = [];

  // 1. Top 5 (min 15 trades)
  const top5 = new Set(qualified.slice(0, 5).map(p => p.name));
  filters.push({ name: "Top 5", politicians: top5, signalsPerMonth: calcSignalsPerMonth(top5) });

  // 2. Ann% >= 50%
  const ann50 = new Set(allStats.filter(p => p.annualizedReturnPct >= 50).map(p => p.name));
  filters.push({ name: "Ann>=50%", politicians: ann50, signalsPerMonth: calcSignalsPerMonth(ann50) });

  // 3. Top 10 (min 15 trades)
  const top10 = new Set(qualified.slice(0, 10).map(p => p.name));
  filters.push({ name: "Top 10", politicians: top10, signalsPerMonth: calcSignalsPerMonth(top10) });

  // 4. Ann% >= 40%
  const ann40 = new Set(allStats.filter(p => p.annualizedReturnPct >= 40).map(p => p.name));
  filters.push({ name: "Ann>=40%", politicians: ann40, signalsPerMonth: calcSignalsPerMonth(ann40) });

  // 5. Top 15 (min 15 trades)
  const top15 = new Set(qualified.slice(0, 15).map(p => p.name));
  filters.push({ name: "Top 15", politicians: top15, signalsPerMonth: calcSignalsPerMonth(top15) });

  return filters;
}

// =============================================================================
// Output Formatting
// =============================================================================

function pad(str: string, len: number, right = false): string {
  if (right) return str.padEnd(len);
  return str.padStart(len);
}

function formatPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatMoney(n: number): string {
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// =============================================================================
// Tests
// =============================================================================

describe("Portfolio Simulation", () => {
  it("should trace ChatGPT + Ann>=40% for 3 months", () => {
    const signals = loadSignals();
    const typedSignals = loadSignalsTyped();

    // Build Ann>=40% filter
    const priceMap = buildPriceMap(typedSignals);
    const politicianNames = [...new Set(typedSignals.map(s => s.politician_name))];
    const allStats: PoliticianStats[] = [];
    for (const name of politicianNames) {
      const stats = calculatePoliticianStats(typedSignals, name, priceMap);
      if (stats && (stats.closedTrades > 0 || stats.trades > 0)) {
        allStats.push(stats);
      }
    }
    const ann40Filter = new Set(allStats.filter(p => p.annualizedReturnPct >= 40).map(p => p.name));

    console.log(`\nAnn>=40% filter: ${ann40Filter.size} politicians`);

    // Run detailed trace for 3 months: 2024-06, 2024-07, 2024-08
    const traceMonths = ["2024-06", "2024-07", "2024-08"];
    const config = CHATGPT_CONFIG;

    // Filter signals to valid ones with disclosure price
    let validSignals = signals.filter(s => s.disclosure_price && s.disclosure_price > 0);
    validSignals = validSignals.filter(s => ann40Filter.has(s.politician_name));
    validSignals.sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

    // Compute politician win rates
    const politicianWinRates = new Map<string, number>();
    const winRateStats = new Map<string, { wins: number; total: number }>();
    for (const signal of signals) {
      if (signal.action !== "buy" || !signal.disclosure_price || signal.disclosure_price <= 0) continue;
      const existing = winRateStats.get(signal.politician_name) || { wins: 0, total: 0 };
      existing.total++;
      if (signal.disclosure_price > (signal.trade_price ?? 0)) {
        existing.wins++;
      }
      winRateStats.set(signal.politician_name, existing);
    }
    for (const [name, { wins, total }] of winRateStats) {
      politicianWinRates.set(name, total > 0 ? wins / total : 0.5);
    }

    // Simulation state (start with some budget already deployed to be realistic)
    let cash = 6000; // Assume we're 6 months in
    const positions: Array<{ ticker: string; shares: number; cost: number; entryPrice: number; entryDate: string }> = [];

    // Track decisions
    interface Decision {
      date: string;
      ticker: string;
      politician: string;
      signalAction: "buy" | "sell";
      tradePrice: number;
      currentPrice: number;
      priceChangePct: number;
      daysSinceTrade: number;
      action: "BUY" | "SELL" | "SKIP";
      reason: string;
      score: number | null;
      positionSize: number | null;
      cashBefore: number;
      cashAfter: number;
      positionCount: number;
    }

    const decisions: Decision[] = [];

    // Pre-filter signals through ALL filters (age, price move, scoring) to get accurate bucket stats
    // This matches what the simulation does - only count signals that would actually execute
    const preFilteredBuySignals = validSignals.filter(simSignal => {
      if (simSignal.action !== "buy") return false;
      const currentPrice = simSignal.disclosure_price!;
      const tradePrice = simSignal.trade_price ?? currentPrice;
      const daysSinceTrade = daysBetween(simSignal.trade_date, simSignal.disclosure_date);
      const priceChangePct = tradePrice > 0 ? ((currentPrice - tradePrice) / tradePrice) * 100 : 0;

      // Apply hard filters
      if (daysSinceTrade > config.max_signal_age_days) return false;
      if (Math.abs(priceChangePct) > config.max_price_move_pct) return false;

      // Apply scoring filter
      if (config.scoring) {
        const enrichedSignal = {
          id: simSignal.id,
          ticker: simSignal.ticker,
          action: simSignal.action as "buy" | "sell",
          asset_type: simSignal.asset_type as any,
          trade_price: tradePrice,
          current_price: currentPrice,
          trade_date: simSignal.trade_date,
          disclosure_date: simSignal.disclosure_date,
          position_size_min: simSignal.position_size_min,
          politician_name: simSignal.politician_name,
          source: simSignal.source,
          days_since_trade: daysSinceTrade,
          days_since_filing: 0,
          price_change_pct: priceChangePct,
        };
        const winRate = politicianWinRates.get(simSignal.politician_name);
        const scoreResult = calculateScoreSync(config.scoring, enrichedSignal, winRate);
        if (scoreResult.score < config.execute_threshold) return false;
      }
      return true;
    });

    // Calculate historical bucket stats from PRE-FILTERED signals (matches simulation)
    const bucketStats = calculateHistoricalBucketStats(preFilteredBuySignals as SimSignal[]);

    console.log("\n" + "═".repeat(180));
    console.log("DETAILED TRACE: ChatGPT + Ann>=40% (2024-06 to 2024-08) - BUCKET-BASED SIZING");
    console.log("═".repeat(180));
    console.log(`\nHistorical bucket stats from PRE-FILTERED signals (${bucketStats.totalMonths} months, ${bucketStats.avgSignalsPerMonth.toFixed(1)} signals/month):`);
    console.log(`  Small:  ${bucketStats.small.count.toFixed(1)}/mo, avg $${bucketStats.small.avgSize.toFixed(0)}, exposure=${bucketStats.small.totalExposure.toFixed(0)}`);
    console.log(`  Medium: ${bucketStats.medium.count.toFixed(1)}/mo, avg $${bucketStats.medium.avgSize.toFixed(0)}, exposure=${bucketStats.medium.totalExposure.toFixed(0)}`);
    console.log(`  Large:  ${bucketStats.large.count.toFixed(1)}/mo, avg $${bucketStats.large.avgSize.toFixed(0)}, exposure=${bucketStats.large.totalExposure.toFixed(0)}`);

    for (const month of traceMonths) {
      // Deposit at start of month
      cash += config.monthly_budget;

      const monthSignals = validSignals.filter(s => s.disclosure_date.startsWith(month));

      // =====================================================================
      // FIRST PASS: Score all signals, identify which pass filters
      // =====================================================================
      interface ScoredSignal {
        simSignal: SimSignal;
        currentPrice: number;
        tradePrice: number;
        daysSinceTrade: number;
        priceChangePct: number;
        score: number;
        passesFilters: boolean;
        skipReason: string;
      }
      const scoredSignals: ScoredSignal[] = [];

      for (const simSignal of monthSignals) {
        const currentPrice = simSignal.disclosure_price!;
        const tradePrice = simSignal.trade_price ?? currentPrice;
        const daysSinceTrade = daysBetween(simSignal.trade_date, simSignal.disclosure_date);
        const priceChangePct = tradePrice > 0 ? ((currentPrice - tradePrice) / tradePrice) * 100 : 0;

        let passesFilters = true;
        let score = 1.0;
        let skipReason = "";

        if (simSignal.action === "sell") {
          // Sells handled separately
          passesFilters = false;
          skipReason = "SELL";
        } else if (daysSinceTrade > config.max_signal_age_days) {
          passesFilters = false;
          skipReason = `Too old (${daysSinceTrade}d > ${config.max_signal_age_days}d)`;
        } else if (Math.abs(priceChangePct) > config.max_price_move_pct) {
          passesFilters = false;
          skipReason = `Price moved too much (${priceChangePct.toFixed(1)}% > ${config.max_price_move_pct}%)`;
        } else {
          // Calculate score
          const enrichedSignal = {
            id: simSignal.id,
            ticker: simSignal.ticker,
            action: simSignal.action as "buy" | "sell",
            asset_type: simSignal.asset_type as any,
            trade_price: tradePrice,
            current_price: currentPrice,
            trade_date: simSignal.trade_date,
            disclosure_date: simSignal.disclosure_date,
            position_size_min: simSignal.position_size_min,
            politician_name: simSignal.politician_name,
            source: simSignal.source,
            days_since_trade: daysSinceTrade,
            days_since_filing: 0,
            price_change_pct: priceChangePct,
          };

          const winRate = politicianWinRates.get(simSignal.politician_name);
          const scoreResult = calculateScoreSync(config.scoring!, enrichedSignal, winRate);
          score = scoreResult.score;

          if (score < config.execute_threshold) {
            passesFilters = false;
            skipReason = `Low score (${score.toFixed(2)} < ${config.execute_threshold})`;
          }
        }

        scoredSignals.push({
          simSignal,
          currentPrice,
          tradePrice,
          daysSinceTrade,
          priceChangePct,
          score,
          passesFilters,
          skipReason,
        });
      }

      // Calculate bucket sizes for this month
      const bucketSizes = calculateBucketSizes(cash, bucketStats);
      const expectedBuys = scoredSignals.filter(s => s.simSignal.action === "buy" && s.passesFilters).length;

      console.log(`\n--- ${month}: ${monthSignals.length} signals, ${expectedBuys} buys pass filters, $${cash.toFixed(0)} cash ---`);
      console.log(`    Bucket sizes: small=$${bucketSizes.small.toFixed(0)}, med=$${bucketSizes.medium.toFixed(0)}, large=$${bucketSizes.large.toFixed(0)}`);

      // =====================================================================
      // SECOND PASS: Execute with bucket-based position sizing
      // =====================================================================

      for (const scored of scoredSignals) {
        const { simSignal, currentPrice, tradePrice, daysSinceTrade, priceChangePct, score, passesFilters, skipReason } = scored;
        const cashBefore = cash;

        let action: "BUY" | "SELL" | "SKIP" = "SKIP";
        let reason = skipReason;
        let positionSize: number | null = null;

        // SELL SIGNAL
        if (simSignal.action === "sell") {
          const posIdx = positions.findIndex(p => p.ticker === simSignal.ticker);
          if (posIdx >= 0) {
            const pos = positions[posIdx];
            const proceeds = pos.shares * currentPrice;
            cash += proceeds;
            positions.splice(posIdx, 1);
            action = "SELL";
            reason = `Closed ${pos.shares.toFixed(1)} shares @ $${currentPrice.toFixed(2)}`;
            positionSize = proceeds;
          } else {
            reason = "No position to sell";
          }
        }
        // BUY SIGNAL
        else if (passesFilters) {
          // Bucket-based position size (matches simulation)
          const bucket = getBucket(simSignal.position_size_min);
          let size = bucketSizes[bucket];

          // Apply day-of-month ramp: positions get larger as month progresses
          // Day 1: 1.0x, Day 15: ~1.5x, Day 31: 2.0x
          const dayOfMonth = parseInt(simSignal.disclosure_date.substring(8, 10), 10);
          const monthRampMultiplier = 1 + (dayOfMonth - 1) / 30;
          size = size * monthRampMultiplier;

          // Apply constraints
          size = Math.min(size, cash);
          size = Math.min(size, cash * (config.sizing.max_position_pct ?? 1.0));
          size = Math.round(size * 100) / 100;

          if (size < 10) {
            reason = `Size too small ($${size.toFixed(0)} < $10)`;
          } else if (size > cash) {
            reason = `Insufficient cash ($${size.toFixed(0)} > $${cash.toFixed(0)})`;
          } else {
            cash -= size;
            positions.push({
              ticker: simSignal.ticker,
              shares: size / currentPrice,
              cost: size,
              entryPrice: currentPrice,
              entryDate: simSignal.disclosure_date,
            });
            action = "BUY";
            reason = `${(size / currentPrice).toFixed(1)} shares @ $${currentPrice.toFixed(2)} [${bucket}]`;
            positionSize = size;
          }
        }

        decisions.push({
          date: simSignal.disclosure_date,
          ticker: simSignal.ticker,
          politician: simSignal.politician_name,
          signalAction: simSignal.action as "buy" | "sell",
          tradePrice,
          currentPrice,
          priceChangePct,
          daysSinceTrade,
          action,
          reason,
          score: simSignal.action === "buy" ? score : null,
          positionSize,
          cashBefore,
          cashAfter: cash,
          positionCount: positions.length,
        });
      }
    }

    // Print decision table
    console.log("\n" + "═".repeat(180));
    console.log("DECISION LOG");
    console.log("═".repeat(180));
    console.log(
      pad("Date", 10, true) + " | " +
      pad("Ticker", 6, true) + " | " +
      pad("Politician", 18, true) + " | " +
      pad("Sig", 4, true) + " | " +
      pad("Days", 4) + " | " +
      pad("Δ%", 7) + " | " +
      pad("Score", 5) + " | " +
      pad("Action", 4, true) + " | " +
      pad("Size", 7) + " | " +
      pad("Cash", 7) + " | " +
      pad("Pos", 3) + " | " +
      "Reason"
    );
    console.log("-".repeat(180));

    for (const d of decisions) {
      const actionColor = d.action === "BUY" ? "BUY " : d.action === "SELL" ? "SELL" : "SKIP";
      console.log(
        pad(d.date.slice(0, 10), 10, true) + " | " +
        pad(d.ticker.slice(0, 6), 6, true) + " | " +
        pad(d.politician.slice(0, 18), 18, true) + " | " +
        pad(d.signalAction.toUpperCase(), 4, true) + " | " +
        pad(String(d.daysSinceTrade), 4) + " | " +
        pad(formatPct(d.priceChangePct).slice(0, 7), 7) + " | " +
        pad(d.score !== null ? d.score.toFixed(2) : "-", 5) + " | " +
        pad(actionColor, 4, true) + " | " +
        pad(d.positionSize !== null ? `$${d.positionSize.toFixed(0)}` : "-", 7) + " | " +
        pad(`$${d.cashAfter.toFixed(0)}`, 7) + " | " +
        pad(String(d.positionCount), 3) + " | " +
        d.reason.slice(0, 55)
      );
    }

    // Summary
    const buys = decisions.filter(d => d.action === "BUY").length;
    const sells = decisions.filter(d => d.action === "SELL").length;
    const skips = decisions.filter(d => d.action === "SKIP").length;

    console.log("\n" + "-".repeat(180));
    console.log(`SUMMARY: ${decisions.length} decisions | ${buys} buys | ${sells} sells | ${skips} skips`);
    console.log(`Final: $${cash.toFixed(0)} cash, ${positions.length} open positions`);

    // Skip reasons breakdown
    const skipReasons = new Map<string, number>();
    for (const d of decisions.filter(d => d.action === "SKIP")) {
      const key = d.reason.split(" (")[0];
      skipReasons.set(key, (skipReasons.get(key) || 0) + 1);
    }
    console.log("\nSKIP REASONS:");
    for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count}`);
    }

    expect(decisions.length).toBeGreaterThan(0);
  });

  it("should run 4 strategies × 5 filters = 20 combinations", () => {
    const signals = loadSignals();
    const typedSignals = loadSignalsTyped();
    console.log(`\nLoaded ${signals.length} signals`);

    // Build politician filters
    const filters = buildPoliticianFilters(typedSignals);
    console.log(`\nBuilt ${filters.length} politician filters:`);
    for (const f of filters) {
      console.log(`  ${f.name}: ${f.politicians.size} politicians, ${f.signalsPerMonth.toFixed(1)} sig/mo`);
    }

    // Define strategies
    const strategies = [
      { name: "ChatGPT", config: CHATGPT_CONFIG },
      { name: "Claude", config: CLAUDE_CONFIG },
      { name: "Gemini", config: GEMINI_CONFIG },
      { name: "Naive", config: NAIVE_CONFIG },
    ];

    // Run all combinations
    interface ResultRow {
      strategy: string;
      filter: string;
      signalsPerMonth: number;
      months: number;
      buys: number;
      sells: number;
      closedTrades: number;
      winRate: number;
      realizedPnL: number;
      finalPortfolio: number;
      totalDeposits: number;
      growthPct: number;
    }

    const results: ResultRow[] = [];

    for (const filter of filters) {
      for (const strategy of strategies) {
        const result = runSimulation(strategy.config, signals, filter.politicians);

        const totalBuys = result.monthlySnapshots.reduce((sum, m) => sum + m.buys, 0);
        const totalSells = result.monthlySnapshots.reduce((sum, m) => sum + m.sells, 0);
        const wins = result.closedTrades.filter(t => t.profit > 0).length;
        const winRate = result.closedTrades.length > 0 ? (wins / result.closedTrades.length) * 100 : 0;
        const lastSnapshot = result.monthlySnapshots[result.monthlySnapshots.length - 1];

        results.push({
          strategy: strategy.name,
          filter: filter.name,
          signalsPerMonth: filter.signalsPerMonth,
          months: result.months,
          buys: totalBuys,
          sells: totalSells,
          closedTrades: result.closedTrades.length,
          winRate,
          realizedPnL: result.realizedPnL,
          finalPortfolio: lastSnapshot?.portfolioValue ?? 0,
          totalDeposits: result.totalDeposits,
          growthPct: lastSnapshot?.growthPct ?? 0,
        });
      }
    }

    // Print results table
    console.log("\n" + "═".repeat(130));
    console.log("STRATEGY × FILTER MATRIX: 4 Strategies × 5 Politician Filters (35 months)");
    console.log("═".repeat(130));

    console.log(
      pad("Strategy", 10, true) + " | " +
      pad("Filter", 10, true) + " | " +
      pad("Sig/Mo", 6) + " | " +
      pad("Buys", 5) + " | " +
      pad("Sells", 5) + " | " +
      pad("Closed", 6) + " | " +
      pad("Win%", 5) + " | " +
      pad("RealPnL", 9) + " | " +
      pad("Deposits", 8) + " | " +
      pad("Portfolio", 10) + " | " +
      pad("Growth", 8)
    );
    console.log("-".repeat(130));

    // Group by filter for better readability
    for (const filter of filters) {
      const filterResults = results.filter(r => r.filter === filter.name);
      for (const r of filterResults) {
        console.log(
          pad(r.strategy, 10, true) + " | " +
          pad(r.filter, 10, true) + " | " +
          pad(r.signalsPerMonth.toFixed(1), 6) + " | " +
          pad(String(r.buys), 5) + " | " +
          pad(String(r.sells), 5) + " | " +
          pad(String(r.closedTrades), 6) + " | " +
          pad(`${r.winRate.toFixed(0)}%`, 5) + " | " +
          pad(formatMoney(r.realizedPnL), 9) + " | " +
          pad(formatMoney(r.totalDeposits), 8) + " | " +
          pad(formatMoney(r.finalPortfolio), 10) + " | " +
          pad(formatPct(r.growthPct), 8)
        );
      }
      console.log("-".repeat(130));
    }

    // Summary: Best combination
    const sortedByGrowth = [...results].sort((a, b) => b.growthPct - a.growthPct);
    console.log("\nTOP 5 COMBINATIONS BY GROWTH:");
    for (let i = 0; i < 5; i++) {
      const r = sortedByGrowth[i];
      console.log(`  ${i + 1}. ${r.strategy} + ${r.filter}: ${formatPct(r.growthPct)} growth, ${formatMoney(r.finalPortfolio)} portfolio`);
    }

    expect(results.length).toBe(20);
  });

  // ===========================================================================
  // NEW TEST SERIES: Score-Based Position Sizing for ChatGPT
  // ===========================================================================

  it("should explore score-to-size relationships for ChatGPT", () => {
    const signals = loadSignals();
    const typedSignals = loadSignalsTyped();

    // Build best filters from previous tests
    const filters = buildPoliticianFilters(typedSignals);
    const topFilters = filters.filter(f => ["Top 10", "Ann>=50%", "Top 5"].includes(f.name));

    console.log("\n" + "═".repeat(140));
    console.log("SCORE-TO-SIZE EXPERIMENT: ChatGPT Strategy with Different Score Multipliers");
    console.log("═".repeat(140));

    // Define score-to-size formulas
    type ScoreFormula = {
      name: string;
      description: string;
      fn: (baseSize: number, score: number) => number;
    };

    const formulas: ScoreFormula[] = [
      {
        name: "None",
        description: "No score factor (current baseline)",
        fn: (baseSize, _score) => baseSize,
      },
      {
        name: "Linear",
        description: "size × score (0.55→55%, 1.0→100%)",
        fn: (baseSize, score) => baseSize * score,
      },
      {
        name: "Squared",
        description: "size × score² (0.55→30%, 1.0→100%)",
        fn: (baseSize, score) => baseSize * score * score,
      },
      {
        name: "Scaled",
        description: "size × (0.5 + score×0.5) (0.55→77.5%, 1.0→100%)",
        fn: (baseSize, score) => baseSize * (0.5 + score * 0.5),
      },
      {
        name: "Boost",
        description: "size × (1 + (score-0.55)×2) (0.55→100%, 1.0→190%)",
        fn: (baseSize, score) => baseSize * (1 + (score - 0.55) * 2),
      },
      {
        name: "Exponential",
        description: "size × 2^(score-0.5) (0.55→103%, 1.0→141%)",
        fn: (baseSize, score) => baseSize * Math.pow(2, score - 0.5),
      },
    ];

    console.log("\nFormulas being tested:");
    for (const f of formulas) {
      console.log(`  ${f.name.padEnd(12)} - ${f.description}`);
    }

    // Custom simulation runner with score-based sizing
    function runWithScoreFormula(
      config: typeof CHATGPT_CONFIG,
      allSignals: SimSignal[],
      politicianFilter: Set<string>,
      scoreFormula: ScoreFormula["fn"]
    ) {
      // Filter and sort signals
      let validSignals = allSignals.filter(s => s.disclosure_price && s.disclosure_price > 0);
      validSignals = validSignals.filter(s => politicianFilter.has(s.politician_name));
      validSignals.sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

      if (validSignals.length === 0) return null;

      // Compute politician win rates
      const politicianWinRates = new Map<string, number>();
      const winRateStats = new Map<string, { wins: number; total: number }>();
      for (const signal of allSignals) {
        if (signal.action !== "buy" || !signal.disclosure_price || signal.disclosure_price <= 0) continue;
        const existing = winRateStats.get(signal.politician_name) || { wins: 0, total: 0 };
        existing.total++;
        if (signal.disclosure_price > (signal.trade_price ?? 0)) {
          existing.wins++;
        }
        winRateStats.set(signal.politician_name, existing);
      }
      for (const [name, { wins, total }] of winRateStats) {
        politicianWinRates.set(name, total > 0 ? wins / total : 0.5);
      }

      // Pre-filter for bucket stats
      const preFilteredBuySignals = validSignals.filter(simSignal => {
        if (simSignal.action !== "buy") return false;
        const currentPrice = simSignal.disclosure_price!;
        const tradePrice = simSignal.trade_price ?? currentPrice;
        const daysSinceTrade = daysBetween(simSignal.trade_date, simSignal.disclosure_date);
        const priceChangePct = tradePrice > 0 ? ((currentPrice - tradePrice) / tradePrice) * 100 : 0;
        if (daysSinceTrade > config.max_signal_age_days) return false;
        if (Math.abs(priceChangePct) > config.max_price_move_pct) return false;
        if (config.scoring) {
          const enrichedSignal = {
            id: simSignal.id, ticker: simSignal.ticker, action: simSignal.action as "buy" | "sell",
            asset_type: simSignal.asset_type as any, trade_price: tradePrice, current_price: currentPrice,
            trade_date: simSignal.trade_date, disclosure_date: simSignal.disclosure_date,
            position_size_min: simSignal.position_size_min, politician_name: simSignal.politician_name,
            source: simSignal.source, days_since_trade: daysSinceTrade, days_since_filing: 0,
            price_change_pct: priceChangePct,
          };
          const winRate = politicianWinRates.get(simSignal.politician_name);
          const scoreResult = calculateScoreSync(config.scoring, enrichedSignal, winRate);
          if (scoreResult.score < config.execute_threshold) return false;
        }
        return true;
      });

      const bucketStats = calculateHistoricalBucketStats(preFilteredBuySignals as SimSignal[]);

      // Generate months
      const startDate = validSignals[0].disclosure_date;
      const endDate = validSignals[validSignals.length - 1].disclosure_date;
      const months: string[] = [];
      let current = new Date(startDate.substring(0, 7) + "-01");
      const end = new Date(endDate.substring(0, 7) + "-01");
      while (current <= end) {
        months.push(current.toISOString().substring(0, 7));
        current.setMonth(current.getMonth() + 1);
      }

      // Simulation state
      let cash = 0;
      let totalDeposits = 0;
      let realizedPnL = 0;
      const positions: Array<{ ticker: string; shares: number; cost: number; entryPrice: number; entryDate: string }> = [];
      const closedTrades: Array<{ profit: number; returnPct: number }> = [];
      let totalBuys = 0;
      let totalSells = 0;

      for (const month of months) {
        cash += config.monthly_budget;
        totalDeposits += config.monthly_budget;
        const bucketSizes = calculateBucketSizes(cash, bucketStats);
        const monthSignals = validSignals.filter(s => s.disclosure_date.startsWith(month));

        for (const simSignal of monthSignals) {
          const currentPrice = simSignal.disclosure_price!;
          const tradePrice = simSignal.trade_price ?? currentPrice;
          const daysSinceTrade = daysBetween(simSignal.trade_date, simSignal.disclosure_date);
          const priceChangePct = tradePrice > 0 ? ((currentPrice - tradePrice) / tradePrice) * 100 : 0;

          // SELL
          if (simSignal.action === "sell") {
            const posIdx = positions.findIndex(p => p.ticker === simSignal.ticker);
            if (posIdx >= 0) {
              const pos = positions[posIdx];
              const proceeds = pos.shares * currentPrice;
              const profit = proceeds - pos.cost;
              cash += proceeds;
              realizedPnL += profit;
              closedTrades.push({ profit, returnPct: (profit / pos.cost) * 100 });
              positions.splice(posIdx, 1);
              totalSells++;
            }
            continue;
          }

          // BUY - apply filters
          if (daysSinceTrade > config.max_signal_age_days) continue;
          if (Math.abs(priceChangePct) > config.max_price_move_pct) continue;

          // Calculate score
          let score = 1.0;
          if (config.scoring) {
            const enrichedSignal = {
              id: simSignal.id, ticker: simSignal.ticker, action: simSignal.action as "buy" | "sell",
              asset_type: simSignal.asset_type as any, trade_price: tradePrice, current_price: currentPrice,
              trade_date: simSignal.trade_date, disclosure_date: simSignal.disclosure_date,
              position_size_min: simSignal.position_size_min, politician_name: simSignal.politician_name,
              source: simSignal.source, days_since_trade: daysSinceTrade, days_since_filing: 0,
              price_change_pct: priceChangePct,
            };
            const winRate = politicianWinRates.get(simSignal.politician_name);
            const scoreResult = calculateScoreSync(config.scoring, enrichedSignal, winRate);
            score = scoreResult.score;
          }

          if (score < config.execute_threshold) continue;

          // Calculate base size from bucket
          const bucket = getBucket(simSignal.position_size_min);
          let baseSize = bucketSizes[bucket];

          // Apply day-of-month ramp
          const dayOfMonth = parseInt(simSignal.disclosure_date.substring(8, 10), 10);
          const monthRampMultiplier = 1 + (dayOfMonth - 1) / 30;
          baseSize = baseSize * monthRampMultiplier;

          // Apply score formula
          let positionSize = scoreFormula(baseSize, score);

          // Constraints
          positionSize = Math.min(positionSize, cash);
          positionSize = Math.min(positionSize, cash * (config.sizing.max_position_pct ?? 1.0));
          positionSize = Math.round(positionSize * 100) / 100;

          if (positionSize < 10 || positionSize > cash) continue;

          cash -= positionSize;
          positions.push({
            ticker: simSignal.ticker,
            shares: positionSize / currentPrice,
            cost: positionSize,
            entryPrice: currentPrice,
            entryDate: simSignal.disclosure_date,
          });
          totalBuys++;
        }
      }

      const deployed = positions.reduce((sum, p) => sum + p.cost, 0);
      const portfolioValue = cash + deployed;
      const wins = closedTrades.filter(t => t.profit > 0).length;

      return {
        totalDeposits,
        portfolioValue,
        growthPct: ((portfolioValue - totalDeposits) / totalDeposits) * 100,
        realizedPnL,
        totalBuys,
        totalSells,
        closedTrades: closedTrades.length,
        winRate: closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0,
        openPositions: positions.length,
      };
    }

    // Run all combinations
    interface ResultRow {
      formula: string;
      filter: string;
      buys: number;
      closed: number;
      winRate: number;
      realizedPnL: number;
      portfolio: number;
      growthPct: number;
    }

    const results: ResultRow[] = [];

    for (const filter of topFilters) {
      for (const formula of formulas) {
        const result = runWithScoreFormula(
          CHATGPT_CONFIG,
          signals as SimSignal[],
          filter.politicians,
          formula.fn
        );

        if (result) {
          results.push({
            formula: formula.name,
            filter: filter.name,
            buys: result.totalBuys,
            closed: result.closedTrades,
            winRate: result.winRate,
            realizedPnL: result.realizedPnL,
            portfolio: result.portfolioValue,
            growthPct: result.growthPct,
          });
        }
      }
    }

    // Print results
    console.log("\n" + "═".repeat(120));
    console.log("RESULTS: ChatGPT + Score Sizing Formulas × Filters");
    console.log("═".repeat(120));

    console.log(
      pad("Formula", 12, true) + " | " +
      pad("Filter", 10, true) + " | " +
      pad("Buys", 5) + " | " +
      pad("Closed", 6) + " | " +
      pad("Win%", 5) + " | " +
      pad("RealPnL", 9) + " | " +
      pad("Portfolio", 10) + " | " +
      pad("Growth", 10)
    );
    console.log("-".repeat(120));

    for (const filter of topFilters) {
      const filterResults = results.filter(r => r.filter === filter.name);
      for (const r of filterResults) {
        console.log(
          pad(r.formula, 12, true) + " | " +
          pad(r.filter, 10, true) + " | " +
          pad(String(r.buys), 5) + " | " +
          pad(String(r.closed), 6) + " | " +
          pad(`${r.winRate.toFixed(0)}%`, 5) + " | " +
          pad(formatMoney(r.realizedPnL), 9) + " | " +
          pad(formatMoney(r.portfolio), 10) + " | " +
          pad(formatPct(r.growthPct), 10)
        );
      }
      console.log("-".repeat(120));
    }

    // Best by filter
    console.log("\nBEST FORMULA PER FILTER:");
    for (const filter of topFilters) {
      const filterResults = results.filter(r => r.filter === filter.name);
      const best = filterResults.sort((a, b) => b.growthPct - a.growthPct)[0];
      console.log(`  ${filter.name.padEnd(10)}: ${best.formula.padEnd(12)} → ${formatPct(best.growthPct)} growth`);
    }

    // Overall best
    const overallBest = [...results].sort((a, b) => b.growthPct - a.growthPct).slice(0, 3);
    console.log("\nTOP 3 OVERALL:");
    for (let i = 0; i < overallBest.length; i++) {
      const r = overallBest[i];
      console.log(`  ${i + 1}. ${r.formula} + ${r.filter}: ${formatPct(r.growthPct)} growth, ${formatMoney(r.portfolio)} portfolio`);
    }

    expect(results.length).toBeGreaterThan(0);
  });

  // ===========================================================================
  // TAX ANALYSIS: Wash Sales and Short/Long-term Capital Gains
  // ===========================================================================

  it("should analyze tax implications for ChatGPT + Linear + Top 10", () => {
    const signals = loadSignals();
    const typedSignals = loadSignalsTyped();

    // Build Top 10 filter (best performing)
    const filters = buildPoliticianFilters(typedSignals);
    const top10Filter = filters.find(f => f.name === "Top 10")!;

    console.log("\n" + "═".repeat(140));
    console.log("TAX ANALYSIS: ChatGPT + Linear Score Sizing + Top 10 Politicians");
    console.log("═".repeat(140));

    const config = CHATGPT_CONFIG;

    // Filter and sort signals
    let validSignals = (signals as SimSignal[]).filter(s => s.disclosure_price && s.disclosure_price > 0);
    validSignals = validSignals.filter(s => top10Filter.politicians.has(s.politician_name));
    validSignals.sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

    // Compute politician win rates
    const politicianWinRates = new Map<string, number>();
    const winRateStats = new Map<string, { wins: number; total: number }>();
    for (const signal of signals) {
      if (signal.action !== "buy" || !signal.disclosure_price || signal.disclosure_price <= 0) continue;
      const existing = winRateStats.get(signal.politician_name) || { wins: 0, total: 0 };
      existing.total++;
      if (signal.disclosure_price > (signal.trade_price ?? 0)) {
        existing.wins++;
      }
      winRateStats.set(signal.politician_name, existing);
    }
    for (const [name, { wins, total }] of winRateStats) {
      politicianWinRates.set(name, total > 0 ? wins / total : 0.5);
    }

    // Pre-filter for bucket stats
    const preFilteredBuySignals = validSignals.filter(simSignal => {
      if (simSignal.action !== "buy") return false;
      const currentPrice = simSignal.disclosure_price!;
      const tradePrice = simSignal.trade_price ?? currentPrice;
      const daysS = daysBetween(simSignal.trade_date, simSignal.disclosure_date);
      const pct = tradePrice > 0 ? ((currentPrice - tradePrice) / tradePrice) * 100 : 0;
      if (daysS > config.max_signal_age_days) return false;
      if (Math.abs(pct) > config.max_price_move_pct) return false;
      if (config.scoring) {
        const enrichedSignal = {
          id: simSignal.id, ticker: simSignal.ticker, action: simSignal.action as "buy" | "sell",
          asset_type: simSignal.asset_type as any, trade_price: tradePrice, current_price: currentPrice,
          trade_date: simSignal.trade_date, disclosure_date: simSignal.disclosure_date,
          position_size_min: simSignal.position_size_min, politician_name: simSignal.politician_name,
          source: simSignal.source, days_since_trade: daysS, days_since_filing: 0, price_change_pct: pct,
        };
        const winRate = politicianWinRates.get(simSignal.politician_name);
        const scoreResult = calculateScoreSync(config.scoring, enrichedSignal, winRate);
        if (scoreResult.score < config.execute_threshold) return false;
      }
      return true;
    });

    const bucketStats = calculateHistoricalBucketStats(preFilteredBuySignals as SimSignal[]);

    // Generate months
    const startDate = validSignals[0].disclosure_date;
    const endDate = validSignals[validSignals.length - 1].disclosure_date;
    const months: string[] = [];
    let current = new Date(startDate.substring(0, 7) + "-01");
    const end = new Date(endDate.substring(0, 7) + "-01");
    while (current <= end) {
      months.push(current.toISOString().substring(0, 7));
      current.setMonth(current.getMonth() + 1);
    }

    // Tax tracking types
    interface TaxLot {
      ticker: string;
      shares: number;
      cost: number;
      entryDate: string;
      entryPrice: number;
    }

    interface ClosedTrade {
      ticker: string;
      shares: number;
      entryDate: string;
      exitDate: string;
      entryPrice: number;
      exitPrice: number;
      profit: number;
      holdDays: number;
      isLongTerm: boolean;
      isWashSale: boolean;
      disallowedLoss: number;
    }

    interface WashSaleEvent {
      ticker: string;
      sellDate: string;
      buyDate: string;
      lossAmount: number;
      disallowed: boolean;
      reason: string;
    }

    // Simulation state
    let cash = 0;
    let totalDeposits = 0;
    const positions: TaxLot[] = [];
    const closedTrades: ClosedTrade[] = [];
    const washSaleEvents: WashSaleEvent[] = [];

    // Track recent buys for wash sale detection (ticker -> dates)
    const recentBuys = new Map<string, string[]>();
    const recentSalesAtLoss = new Map<string, { date: string; loss: number }[]>();

    // Linear score formula
    const scoreFormula = (baseSize: number, score: number) => baseSize * score;

    for (const month of months) {
      cash += config.monthly_budget;
      totalDeposits += config.monthly_budget;
      const bucketSizes = calculateBucketSizes(cash, bucketStats);
      const monthSignals = validSignals.filter(s => s.disclosure_date.startsWith(month));

      for (const simSignal of monthSignals) {
        const currentPrice = simSignal.disclosure_price!;
        const tradePrice = simSignal.trade_price ?? currentPrice;
        const daysSinceTrade = daysBetween(simSignal.trade_date, simSignal.disclosure_date);
        const priceChangePct = tradePrice > 0 ? ((currentPrice - tradePrice) / tradePrice) * 100 : 0;

        // SELL
        if (simSignal.action === "sell") {
          const posIdx = positions.findIndex(p => p.ticker === simSignal.ticker);
          if (posIdx >= 0) {
            const pos = positions[posIdx];
            const proceeds = pos.shares * currentPrice;
            const profit = proceeds - pos.cost;
            const holdDays = daysBetween(pos.entryDate, simSignal.disclosure_date);
            const isLongTerm = holdDays >= 365;

            // Check for wash sale: did we buy this ticker within 30 days before?
            let isWashSale = false;
            let disallowedLoss = 0;

            if (profit < 0) {
              // This is a loss - check for wash sale
              const tickerBuys = recentBuys.get(simSignal.ticker) || [];
              const sellDate = new Date(simSignal.disclosure_date);

              for (const buyDateStr of tickerBuys) {
                const buyDate = new Date(buyDateStr);
                const daysDiff = Math.abs((sellDate.getTime() - buyDate.getTime()) / (1000 * 60 * 60 * 24));
                if (daysDiff <= 30) {
                  isWashSale = true;
                  disallowedLoss = Math.abs(profit);
                  washSaleEvents.push({
                    ticker: simSignal.ticker,
                    sellDate: simSignal.disclosure_date,
                    buyDate: buyDateStr,
                    lossAmount: Math.abs(profit),
                    disallowed: true,
                    reason: `Bought ${daysDiff.toFixed(0)} days before sell`,
                  });
                  break;
                }
              }

              // Track this loss for future wash sale detection (only keep last 60 days)
              const losses = recentSalesAtLoss.get(simSignal.ticker) || [];
              losses.push({ date: simSignal.disclosure_date, loss: Math.abs(profit) });
              // Clean up old losses (more than 60 days ago)
              const lossCutoff = new Date(simSignal.disclosure_date);
              lossCutoff.setDate(lossCutoff.getDate() - 60);
              recentSalesAtLoss.set(
                simSignal.ticker,
                losses.filter(l => new Date(l.date) >= lossCutoff)
              );
            }

            cash += proceeds;
            closedTrades.push({
              ticker: simSignal.ticker,
              shares: pos.shares,
              entryDate: pos.entryDate,
              exitDate: simSignal.disclosure_date,
              entryPrice: pos.entryPrice,
              exitPrice: currentPrice,
              profit,
              holdDays,
              isLongTerm,
              isWashSale,
              disallowedLoss,
            });
            positions.splice(posIdx, 1);
          }
          continue;
        }

        // BUY - apply filters
        if (daysSinceTrade > config.max_signal_age_days) continue;
        if (Math.abs(priceChangePct) > config.max_price_move_pct) continue;

        // Calculate score
        let score = 1.0;
        if (config.scoring) {
          const enrichedSignal = {
            id: simSignal.id, ticker: simSignal.ticker, action: simSignal.action as "buy" | "sell",
            asset_type: simSignal.asset_type as any, trade_price: tradePrice, current_price: currentPrice,
            trade_date: simSignal.trade_date, disclosure_date: simSignal.disclosure_date,
            position_size_min: simSignal.position_size_min, politician_name: simSignal.politician_name,
            source: simSignal.source, days_since_trade: daysSinceTrade, days_since_filing: 0,
            price_change_pct: priceChangePct,
          };
          const winRate = politicianWinRates.get(simSignal.politician_name);
          const scoreResult = calculateScoreSync(config.scoring, enrichedSignal, winRate);
          score = scoreResult.score;
        }

        if (score < config.execute_threshold) continue;

        // Calculate position size
        const bucket = getBucket(simSignal.position_size_min);
        let baseSize = bucketSizes[bucket];
        const dayOfMonth = parseInt(simSignal.disclosure_date.substring(8, 10), 10);
        const monthRampMultiplier = 1 + (dayOfMonth - 1) / 30;
        baseSize = baseSize * monthRampMultiplier;
        let positionSize = scoreFormula(baseSize, score);

        positionSize = Math.min(positionSize, cash);
        positionSize = Math.min(positionSize, cash * (config.sizing.max_position_pct ?? 1.0));
        positionSize = Math.round(positionSize * 100) / 100;

        if (positionSize < 10 || positionSize > cash) continue;

        // WASH SALE PREVENTION: Block buy if we sold this ticker at a loss within 30 days
        const losses = recentSalesAtLoss.get(simSignal.ticker) || [];
        const buyDate = new Date(simSignal.disclosure_date);
        let wouldTriggerWashSale = false;
        for (const loss of losses) {
          const lossDate = new Date(loss.date);
          const daysDiff = (buyDate.getTime() - lossDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysDiff >= 0 && daysDiff <= 30) {
            wouldTriggerWashSale = true;
            washSaleEvents.push({
              ticker: simSignal.ticker,
              sellDate: loss.date,
              buyDate: simSignal.disclosure_date,
              lossAmount: loss.loss,
              disallowed: false, // Not disallowed because we're blocking the buy
              reason: `BLOCKED: Would buy ${daysDiff.toFixed(0)} days after loss sale`,
            });
            break;
          }
        }

        // Skip this buy to avoid wash sale
        if (wouldTriggerWashSale) continue;

        // Track this buy for future wash sale detection
        const buys = recentBuys.get(simSignal.ticker) || [];
        buys.push(simSignal.disclosure_date);
        // Keep only last 60 days of buys
        const cutoff = new Date(simSignal.disclosure_date);
        cutoff.setDate(cutoff.getDate() - 60);
        recentBuys.set(simSignal.ticker, buys.filter(d => new Date(d) >= cutoff));

        cash -= positionSize;
        positions.push({
          ticker: simSignal.ticker,
          shares: positionSize / currentPrice,
          cost: positionSize,
          entryPrice: currentPrice,
          entryDate: simSignal.disclosure_date,
        });
      }
    }

    // Calculate tax summary
    const shortTermGains = closedTrades.filter(t => !t.isLongTerm && t.profit > 0);
    const shortTermLosses = closedTrades.filter(t => !t.isLongTerm && t.profit < 0);
    const longTermGains = closedTrades.filter(t => t.isLongTerm && t.profit > 0);
    const longTermLosses = closedTrades.filter(t => t.isLongTerm && t.profit < 0);

    const totalShortTermGain = shortTermGains.reduce((sum, t) => sum + t.profit, 0);
    const totalShortTermLoss = shortTermLosses.reduce((sum, t) => sum + Math.abs(t.profit), 0);
    const totalLongTermGain = longTermGains.reduce((sum, t) => sum + t.profit, 0);
    const totalLongTermLoss = longTermLosses.reduce((sum, t) => sum + Math.abs(t.profit), 0);

    // Print results
    console.log("\n" + "─".repeat(80));
    console.log("CAPITAL GAINS SUMMARY");
    console.log("─".repeat(80));
    console.log(`\nShort-term (held < 1 year) - taxed as ordinary income:`);
    console.log(`  Gains:  ${shortTermGains.length} trades, ${formatMoney(totalShortTermGain)}`);
    console.log(`  Losses: ${shortTermLosses.length} trades, -${formatMoney(totalShortTermLoss)}`);
    console.log(`  Net:    ${formatMoney(totalShortTermGain - totalShortTermLoss)}`);

    console.log(`\nLong-term (held >= 1 year) - taxed at capital gains rate:`);
    console.log(`  Gains:  ${longTermGains.length} trades, ${formatMoney(totalLongTermGain)}`);
    console.log(`  Losses: ${longTermLosses.length} trades, -${formatMoney(totalLongTermLoss)}`);
    console.log(`  Net:    ${formatMoney(totalLongTermGain - totalLongTermLoss)}`);

    console.log("\n" + "─".repeat(80));
    console.log("WASH SALE ANALYSIS");
    console.log("─".repeat(80));

    // Separate detected wash sales (sell-side) from blocked buys (buy-side)
    const detectedWashSales = washSaleEvents.filter(e => e.disallowed);
    const blockedBuys = washSaleEvents.filter(e => !e.disallowed);
    const totalDisallowedLoss = detectedWashSales.reduce((sum, e) => sum + e.lossAmount, 0);
    const totalProtectedLoss = blockedBuys.reduce((sum, e) => sum + e.lossAmount, 0);

    console.log(`\nDetected wash sales (bought then sold at loss within 30 days):`);
    console.log(`  Count: ${detectedWashSales.length} trades`);
    console.log(`  Disallowed losses: ${formatMoney(totalDisallowedLoss)}`);

    console.log(`\nBlocked buys (prevented buying within 30 days of loss sale):`);
    console.log(`  Count: ${blockedBuys.length} trades`);
    console.log(`  Losses protected: ${formatMoney(totalProtectedLoss)}`);

    if (detectedWashSales.length > 0) {
      console.log(`\nDetected wash sale events (first 5):`);
      for (const event of detectedWashSales.slice(0, 5)) {
        console.log(`  ${event.ticker}: Bought ${event.buyDate.slice(0, 10)} → Sold at loss ${event.sellDate.slice(0, 10)} | ${formatMoney(event.lossAmount)} disallowed`);
      }
    }

    if (blockedBuys.length > 0) {
      console.log(`\nBlocked buy events (first 5):`);
      for (const event of blockedBuys.slice(0, 5)) {
        console.log(`  ${event.ticker}: Loss on ${event.sellDate.slice(0, 10)} → Buy blocked ${event.buyDate.slice(0, 10)} | ${formatMoney(event.lossAmount)} protected`);
      }
    }

    // Hold period distribution
    console.log("\n" + "─".repeat(80));
    console.log("HOLD PERIOD DISTRIBUTION");
    console.log("─".repeat(80));
    const holdPeriods = closedTrades.map(t => t.holdDays);
    const avgHold = holdPeriods.reduce((a, b) => a + b, 0) / holdPeriods.length;
    const under30 = closedTrades.filter(t => t.holdDays < 30).length;
    const under90 = closedTrades.filter(t => t.holdDays >= 30 && t.holdDays < 90).length;
    const under180 = closedTrades.filter(t => t.holdDays >= 90 && t.holdDays < 180).length;
    const under365 = closedTrades.filter(t => t.holdDays >= 180 && t.holdDays < 365).length;
    const over365 = closedTrades.filter(t => t.holdDays >= 365).length;

    console.log(`\nAverage hold period: ${avgHold.toFixed(0)} days`);
    console.log(`\nDistribution:`);
    console.log(`  < 30 days:    ${under30} trades (${((under30 / closedTrades.length) * 100).toFixed(0)}%)`);
    console.log(`  30-90 days:   ${under90} trades (${((under90 / closedTrades.length) * 100).toFixed(0)}%)`);
    console.log(`  90-180 days:  ${under180} trades (${((under180 / closedTrades.length) * 100).toFixed(0)}%)`);
    console.log(`  180-365 days: ${under365} trades (${((under365 / closedTrades.length) * 100).toFixed(0)}%)`);
    console.log(`  > 365 days:   ${over365} trades (${((over365 / closedTrades.length) * 100).toFixed(0)}%) - LONG TERM`);

    // Tax efficiency score
    const taxEfficiency = (totalLongTermGain - totalLongTermLoss) /
      ((totalShortTermGain - totalShortTermLoss) + (totalLongTermGain - totalLongTermLoss) + 0.01);

    console.log("\n" + "─".repeat(80));
    console.log("TAX EFFICIENCY");
    console.log("─".repeat(80));
    console.log(`\nLong-term gains as % of total gains: ${(taxEfficiency * 100).toFixed(1)}%`);
    console.log(`  (Higher is better - long-term gains taxed at lower rate)`);

    // Portfolio summary
    const deployed = positions.reduce((sum, p) => sum + p.cost, 0);
    const portfolioValue = cash + deployed;
    const totalRealizedPnL = closedTrades.reduce((sum, t) => sum + t.profit, 0);

    console.log("\n" + "─".repeat(80));
    console.log("PORTFOLIO SUMMARY");
    console.log("─".repeat(80));
    console.log(`\nTotal deposits: ${formatMoney(totalDeposits)}`);
    console.log(`Portfolio value: ${formatMoney(portfolioValue)}`);
    console.log(`Growth: ${formatPct(((portfolioValue - totalDeposits) / totalDeposits) * 100)}`);
    console.log(`\nTotal closed trades: ${closedTrades.length}`);
    console.log(`Realized P&L: ${formatMoney(totalRealizedPnL)}`);
    console.log(`Open positions: ${positions.length}`);

    expect(closedTrades.length).toBeGreaterThan(0);
  });
});
