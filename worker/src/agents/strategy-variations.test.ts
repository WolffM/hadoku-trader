/**
 * Strategy Variations Test
 *
 * Tests 5 variations of ChatGPT strategy with varying restrictiveness:
 * - p2ChatGPT (+2): Most liberal - lower threshold, older signals OK, larger price moves OK
 * - p1ChatGPT (+1): Somewhat liberal
 * - nChatGPT (0): Normal/current settings
 * - m1ChatGPT (-1): Somewhat conservative
 * - m2ChatGPT (-2): Most conservative - higher threshold, fresh signals only, small price moves
 *
 * Based on retrospective findings:
 * 1. Signal freshness (3-7 days) is critical for returns
 * 2. Lower thresholds capture more profitable trades
 * 3. Larger congressional positions correlate with returns
 * 4. Buying dips works well
 *
 * Run with: cd worker && pnpm test strategy-variations
 */

import { describe, it, expect } from "vitest";
import { CHATGPT_CONFIG } from "./configs";
import type { AgentConfig, ScoringConfig } from "./types";
import { calculateHistoricalBucketStats, calculateBucketSizes, getBucket, type SimSignal } from "./simulation";
import { calculateScoreSync } from "./scoring";
import { loadSignalsFromExport, daysBetween } from "./test-utils";

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
  return loadSignalsFromExport();
}

function loadSignalsTyped(): Signal[] {
  return loadSignalsFromExport().filter((s: Signal) =>
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
// Politician Performance (for Top 10 filter)
// =============================================================================

interface PoliticianStats {
  name: string;
  party: "D" | "R";
  trades: number;
  closedTrades: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
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

function calculatePoliticianStats(
  signals: Signal[],
  politicianName: string,
  priceMap: Map<string, { price: number; date: string }>
): PoliticianStats | null {
  const politicianSignals = signals.filter(s => s.politician_name === politicianName);
  if (politicianSignals.length === 0) return null;

  const first = politicianSignals[0];
  const tickerSignals = new Map<string, Signal[]>();
  for (const signal of politicianSignals) {
    if (!tickerSignals.has(signal.ticker)) {
      tickerSignals.set(signal.ticker, []);
    }
    tickerSignals.get(signal.ticker)!.push(signal);
  }

  interface ClosedTrade {
    returnPct: number;
    holdDays: number;
    profit: number;
  }

  const closedTrades: ClosedTrade[] = [];
  const openPositions: { cost: number; currentValue?: number }[] = [];

  for (const [ticker, tickerSigs] of tickerSignals) {
    const sorted = tickerSigs.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    const positionQueue: { shares: number; entryPrice: number; entryDate: string; cost: number }[] = [];

    for (const signal of sorted) {
      if (signal.action === "buy") {
        const shares = signal.position_size_min / signal.trade_price;
        positionQueue.push({
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
          closedTrades.push({ returnPct, holdDays: Math.max(0, holdDays), profit });
        }
      }
    }

    for (const position of positionQueue) {
      const latestPrice = priceMap.get(ticker);
      if (latestPrice) {
        openPositions.push({
          cost: position.cost,
          currentValue: position.shares * latestPrice.price,
        });
      }
    }
  }

  if (closedTrades.length === 0 && openPositions.length === 0) return null;

  const totalCostOfClosed = closedTrades.reduce((sum, t) => sum + 100, 0); // Simplified
  const realizedPnL = closedTrades.reduce((sum, t) => sum + t.profit, 0);
  const openWithPrices = openPositions.filter(p => p.currentValue !== undefined);
  const totalCostOfOpen = openWithPrices.reduce((sum, p) => sum + p.cost, 0);
  const unrealizedPnL = openWithPrices.reduce((sum, p) => sum + ((p.currentValue ?? 0) - p.cost), 0);
  const totalCost = totalCostOfClosed + totalCostOfOpen || 1;
  const totalReturn = ((realizedPnL + unrealizedPnL) / totalCost) * 100;
  const avgHoldDays = closedTrades.length > 0
    ? closedTrades.reduce((sum, t) => sum + t.holdDays, 0) / closedTrades.length
    : 365;
  const annualized = avgHoldDays > 30
    ? (Math.pow(1 + totalReturn / 100, 365 / avgHoldDays) - 1) * 100
    : totalReturn;

  return {
    name: politicianName,
    party: first.politician_party,
    trades: politicianSignals.length,
    closedTrades: closedTrades.length,
    totalReturnPct: totalReturn,
    annualizedReturnPct: annualized,
  };
}

function buildTop10Filter(typedSignals: Signal[]): Set<string> {
  const priceMap = buildPriceMap(typedSignals);
  const politicianNames = [...new Set(typedSignals.map(s => s.politician_name))];
  const allStats: PoliticianStats[] = [];

  for (const name of politicianNames) {
    const stats = calculatePoliticianStats(typedSignals, name, priceMap);
    if (stats && stats.closedTrades >= 5) {
      allStats.push(stats);
    }
  }

  // Sort by annualized return, take top 10
  const top10 = allStats
    .sort((a, b) => b.annualizedReturnPct - a.annualizedReturnPct)
    .slice(0, 10);

  return new Set(top10.map(p => p.name));
}

// =============================================================================
// Strategy Variations
// =============================================================================

interface StrategyVariation {
  name: string;
  description: string;
  max_signal_age_days: number;
  max_price_move_pct: number;
  execute_threshold: number;
  scoring_weights: {
    time_decay: number;
    price_movement: number;
    position_size: number;
    politician_skill: number;
    source_quality: number;
  };
}

// Extract current ChatGPT weights from config
const CURRENT_WEIGHTS = {
  time_decay: CHATGPT_CONFIG.scoring!.components.time_decay!.weight,
  price_movement: CHATGPT_CONFIG.scoring!.components.price_movement!.weight,
  position_size: CHATGPT_CONFIG.scoring!.components.position_size!.weight,
  politician_skill: CHATGPT_CONFIG.scoring!.components.politician_skill!.weight,
  source_quality: CHATGPT_CONFIG.scoring!.components.source_quality!.weight,
};

const STRATEGY_VARIATIONS: StrategyVariation[] = [
  {
    name: "p2ChatGPT",
    description: "Most liberal: low threshold, old signals OK, big price moves OK",
    max_signal_age_days: 60,
    max_price_move_pct: 35,
    execute_threshold: 0.35,
    scoring_weights: {
      time_decay: 0.10,
      price_movement: 0.15,
      position_size: 0.35, // Heavy weight on conviction
      politician_skill: 0.25,
      source_quality: 0.15,
    },
  },
  {
    name: "p1ChatGPT",
    description: "Somewhat liberal: lower threshold, accept more signals",
    max_signal_age_days: 45,
    max_price_move_pct: 28,
    execute_threshold: 0.45,
    scoring_weights: {
      time_decay: 0.15,
      price_movement: 0.18,
      position_size: 0.30,
      politician_skill: 0.22,
      source_quality: 0.15,
    },
  },
  {
    name: "nChatGPT",
    description: "Normal: current ChatGPT settings",
    max_signal_age_days: CHATGPT_CONFIG.max_signal_age_days,
    max_price_move_pct: CHATGPT_CONFIG.max_price_move_pct,
    execute_threshold: CHATGPT_CONFIG.execute_threshold,
    scoring_weights: CURRENT_WEIGHTS,
  },
  {
    name: "m1ChatGPT",
    description: "Somewhat conservative: higher threshold, fresher signals",
    max_signal_age_days: 21,
    max_price_move_pct: 18,
    execute_threshold: 0.60,
    scoring_weights: {
      time_decay: 0.30, // Heavy weight on freshness
      price_movement: 0.20,
      position_size: 0.20,
      politician_skill: 0.20,
      source_quality: 0.10,
    },
  },
  {
    name: "m2ChatGPT",
    description: "Most conservative: high threshold, very fresh signals only",
    max_signal_age_days: 14,
    max_price_move_pct: 12,
    execute_threshold: 0.65,
    scoring_weights: {
      time_decay: 0.40, // Maximum weight on freshness (3-7 days best)
      price_movement: 0.15,
      position_size: 0.20,
      politician_skill: 0.15,
      source_quality: 0.10,
    },
  },
];

// =============================================================================
// Simulation Runner
// =============================================================================

function createConfigFromVariation(variation: StrategyVariation): AgentConfig {
  // Clone the base config and update scoring component weights
  const scoring = CHATGPT_CONFIG.scoring ? {
    components: {
      time_decay: {
        ...CHATGPT_CONFIG.scoring.components.time_decay!,
        weight: variation.scoring_weights.time_decay,
      },
      price_movement: {
        ...CHATGPT_CONFIG.scoring.components.price_movement!,
        weight: variation.scoring_weights.price_movement,
      },
      position_size: {
        ...CHATGPT_CONFIG.scoring.components.position_size!,
        weight: variation.scoring_weights.position_size,
      },
      politician_skill: {
        ...CHATGPT_CONFIG.scoring.components.politician_skill!,
        weight: variation.scoring_weights.politician_skill,
      },
      source_quality: {
        ...CHATGPT_CONFIG.scoring.components.source_quality!,
        weight: variation.scoring_weights.source_quality,
      },
    },
  } : null;

  return {
    ...CHATGPT_CONFIG,
    name: variation.name,
    max_signal_age_days: variation.max_signal_age_days,
    max_price_move_pct: variation.max_price_move_pct,
    execute_threshold: variation.execute_threshold,
    scoring,
  };
}

interface SimulationResult {
  variation: string;
  description: string;
  totalDeposits: number;
  portfolioValue: number;
  growthPct: number;
  realizedPnL: number;
  totalBuys: number;
  totalSells: number;
  closedTrades: number;
  winRate: number;
  avgReturn: number;
  openPositions: number;
}

function runVariationSimulation(
  variation: StrategyVariation,
  allSignals: SimSignal[],
  politicianFilter: Set<string>
): SimulationResult | null {
  const config = createConfigFromVariation(variation);

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

  // Linear score formula (best from previous tests)
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
  const avgReturn = closedTrades.length > 0
    ? closedTrades.reduce((sum, t) => sum + t.returnPct, 0) / closedTrades.length
    : 0;

  return {
    variation: variation.name,
    description: variation.description,
    totalDeposits,
    portfolioValue,
    growthPct: ((portfolioValue - totalDeposits) / totalDeposits) * 100,
    realizedPnL,
    totalBuys,
    totalSells,
    closedTrades: closedTrades.length,
    winRate: closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0,
    avgReturn,
    openPositions: positions.length,
  };
}

// =============================================================================
// Formatting Helpers
// =============================================================================

function pad(str: string, len: number, left = false): string {
  if (str.length >= len) return str.substring(0, len);
  const padding = " ".repeat(len - str.length);
  return left ? str + padding : padding + str;
}

function formatPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatMoney(n: number): string {
  if (Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(1)}K`;
  }
  return `$${n.toFixed(0)}`;
}

// =============================================================================
// Tests
// =============================================================================

describe("Strategy Variations", () => {
  it("should compare 5 ChatGPT variations with Top 10 politicians", () => {
    const signals = loadSignals();
    const typedSignals = loadSignalsTyped();

    // Build Top 10 filter
    const top10Filter = buildTop10Filter(typedSignals);

    console.log("\n" + "═".repeat(140));
    console.log("STRATEGY VARIATIONS TEST: 5 ChatGPT Variations × Top 10 Politicians");
    console.log("═".repeat(140));

    console.log("\nVariations being tested:");
    for (const v of STRATEGY_VARIATIONS) {
      console.log(`  ${v.name.padEnd(12)} - ${v.description}`);
      console.log(`    age≤${v.max_signal_age_days}d, move≤${v.max_price_move_pct}%, threshold≥${v.execute_threshold}`);
    }

    console.log(`\nTop 10 politicians: ${[...top10Filter].join(", ")}`);

    // Run all variations
    const results: SimulationResult[] = [];
    for (const variation of STRATEGY_VARIATIONS) {
      const result = runVariationSimulation(variation, signals as SimSignal[], top10Filter);
      if (result) {
        results.push(result);
      }
    }

    // Print results table
    console.log("\n" + "═".repeat(140));
    console.log("RESULTS");
    console.log("═".repeat(140));

    console.log(
      pad("Variation", 12, true) + " | " +
      pad("Buys", 5) + " | " +
      pad("Closed", 6) + " | " +
      pad("Win%", 6) + " | " +
      pad("AvgRet", 8) + " | " +
      pad("RealPnL", 10) + " | " +
      pad("Portfolio", 11) + " | " +
      pad("Growth", 10) + " | " +
      "Description"
    );
    console.log("-".repeat(140));

    for (const r of results) {
      console.log(
        pad(r.variation, 12, true) + " | " +
        pad(String(r.totalBuys), 5) + " | " +
        pad(String(r.closedTrades), 6) + " | " +
        pad(`${r.winRate.toFixed(0)}%`, 6) + " | " +
        pad(formatPct(r.avgReturn), 8) + " | " +
        pad(formatMoney(r.realizedPnL), 10) + " | " +
        pad(formatMoney(r.portfolioValue), 11) + " | " +
        pad(formatPct(r.growthPct), 10) + " | " +
        r.description.slice(0, 45)
      );
    }

    // Summary
    console.log("\n" + "-".repeat(140));
    const sortedByGrowth = [...results].sort((a, b) => b.growthPct - a.growthPct);
    console.log("\nRANKED BY PORTFOLIO GROWTH:");
    for (let i = 0; i < sortedByGrowth.length; i++) {
      const r = sortedByGrowth[i];
      const marker = r.variation === "nChatGPT" ? " ← CURRENT" : "";
      console.log(`  ${i + 1}. ${r.variation.padEnd(12)}: ${formatPct(r.growthPct)} growth, ${formatMoney(r.portfolioValue)} portfolio${marker}`);
    }

    // Trade quality analysis
    console.log("\n" + "-".repeat(140));
    console.log("TRADE QUALITY ANALYSIS:");
    console.log(
      pad("Variation", 12, true) + " | " +
      pad("Signals/Mo", 10) + " | " +
      pad("Win Rate", 10) + " | " +
      pad("Avg Return", 12) + " | " +
      "Quality Score (WR × AvgRet)"
    );
    console.log("-".repeat(80));

    for (const r of results) {
      const months = r.totalDeposits / 1000; // Assuming $1000/month
      const signalsPerMonth = r.totalBuys / months;
      const qualityScore = (r.winRate / 100) * r.avgReturn;
      console.log(
        pad(r.variation, 12, true) + " | " +
        pad(signalsPerMonth.toFixed(1), 10) + " | " +
        pad(`${r.winRate.toFixed(1)}%`, 10) + " | " +
        pad(formatPct(r.avgReturn), 12) + " | " +
        qualityScore.toFixed(2)
      );
    }

    // Parameter comparison
    console.log("\n" + "-".repeat(140));
    console.log("PARAMETER COMPARISON:");
    console.log(
      pad("Variation", 12, true) + " | " +
      pad("MaxAge", 8) + " | " +
      pad("MaxMove", 9) + " | " +
      pad("Threshold", 10) + " | " +
      pad("TimeWt", 8) + " | " +
      pad("SizeWt", 8) + " | " +
      pad("→ Growth", 10)
    );
    console.log("-".repeat(90));

    for (const v of STRATEGY_VARIATIONS) {
      const r = results.find(r => r.variation === v.name);
      const growth = r ? formatPct(r.growthPct) : "N/A";
      console.log(
        pad(v.name, 12, true) + " | " +
        pad(`${v.max_signal_age_days}d`, 8) + " | " +
        pad(`${v.max_price_move_pct}%`, 9) + " | " +
        pad(v.execute_threshold.toFixed(2), 10) + " | " +
        pad(`${(v.scoring_weights.time_decay * 100).toFixed(0)}%`, 8) + " | " +
        pad(`${(v.scoring_weights.position_size * 100).toFixed(0)}%`, 8) + " | " +
        pad(growth, 10)
      );
    }

    // Insights
    console.log("\n" + "═".repeat(140));
    console.log("INSIGHTS");
    console.log("═".repeat(140));

    const best = sortedByGrowth[0];
    const worst = sortedByGrowth[sortedByGrowth.length - 1];
    const normal = results.find(r => r.variation === "nChatGPT");

    if (normal) {
      const improvement = best.growthPct - normal.growthPct;
      console.log(`\nBest strategy: ${best.variation} with ${formatPct(best.growthPct)} growth`);
      console.log(`Current (nChatGPT): ${formatPct(normal.growthPct)} growth`);
      console.log(`Potential improvement: ${formatPct(improvement)}`);
      console.log(`\nWorst strategy: ${worst.variation} with ${formatPct(worst.growthPct)} growth`);

      // Determine pattern
      const liberalAvg = (results.find(r => r.variation === "p2ChatGPT")!.growthPct +
                         results.find(r => r.variation === "p1ChatGPT")!.growthPct) / 2;
      const conservativeAvg = (results.find(r => r.variation === "m1ChatGPT")!.growthPct +
                               results.find(r => r.variation === "m2ChatGPT")!.growthPct) / 2;

      if (liberalAvg > conservativeAvg) {
        console.log(`\nPattern: Liberal strategies (lower thresholds) outperform by ${formatPct(liberalAvg - conservativeAvg)}`);
      } else {
        console.log(`\nPattern: Conservative strategies (higher thresholds) outperform by ${formatPct(conservativeAvg - liberalAvg)}`);
      }
    }

    expect(results.length).toBe(5);
  });
});
