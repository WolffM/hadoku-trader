/**
 * Monthly Detail Test - Shows every decision for one month in table format
 * Run with: cd worker && pnpm test monthly-detail
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  daysBetween,
  type SignalForSim,
} from "./simulation";
import {
  CHATGPT_CONFIG,
  CLAUDE_CONFIG,
  GEMINI_CONFIG,
  NAIVE_CONFIG,
} from "./configs";
import type { AgentConfig, AssetType, SkipReason } from "./types";
import { getReasonDisplay } from "./types";
import { calculatePositionSize, getSmartBudgetBreakdown, getBucketForSize } from "./sizing";

// =============================================================================
// Types
// =============================================================================

interface RealSignal {
  id: string;
  source: string;
  politician_name: string;
  ticker: string;
  action: string;
  asset_type: string;
  position_size_min: number;
  trade_date: string;
  trade_price: number;
  disclosure_date: string;
  disclosure_price: number | null;
}

interface DataExport {
  signals: RealSignal[];
}

// =============================================================================
// Price Provider
// =============================================================================

class SimplePriceProvider {
  private prices: Map<string, Map<string, number>> = new Map();

  constructor(signals: RealSignal[]) {
    for (const signal of signals) {
      if (!signal.trade_price || signal.trade_price <= 0) continue;

      const ticker = signal.ticker;
      if (!this.prices.has(ticker)) {
        this.prices.set(ticker, new Map());
      }

      this.prices.get(ticker)!.set(signal.trade_date, signal.trade_price);
      if (signal.disclosure_price && signal.disclosure_price > 0) {
        this.prices.get(ticker)!.set(signal.disclosure_date, signal.disclosure_price);
      }
    }
  }

  getPrice(ticker: string, date: string): number | null {
    const tickerPrices = this.prices.get(ticker);
    if (!tickerPrices) return null;

    if (tickerPrices.has(date)) {
      return tickerPrices.get(date)!;
    }

    let closestDate: string | null = null;
    let closestPrice: number | null = null;

    for (const [priceDate, price] of tickerPrices.entries()) {
      if (priceDate <= date) {
        if (!closestDate || priceDate > closestDate) {
          closestDate = priceDate;
          closestPrice = price;
        }
      }
    }

    return closestPrice;
  }
}

// =============================================================================
// Load Data
// =============================================================================

function loadRealSignals(): SignalForSim[] {
  const exportPath = path.join(__dirname, "../../../trader-db-export.json");
  const data: DataExport = JSON.parse(fs.readFileSync(exportPath, "utf-8"));

  return data.signals
    .filter(s =>
      s.ticker &&
      s.trade_date &&
      s.trade_price > 0 &&
      s.disclosure_date &&
      s.action === "buy" &&
      s.asset_type
    )
    .map(s => ({
      id: s.id,
      ticker: s.ticker,
      action: s.action as "buy" | "sell",
      asset_type: s.asset_type as AssetType,
      trade_price: s.trade_price,
      trade_date: s.trade_date,
      disclosure_date: s.disclosure_date,
      position_size_min: s.position_size_min || 1000,
      politician_name: s.politician_name,
      source: s.source,
    }));
}

// =============================================================================
// Scoring Simulation (for ChatGPT/Claude agents)
// =============================================================================

interface ScoreComponents {
  time_decay: number;
  price_movement: number;
  position_size: number;
  filing_speed?: number;
  weighted_total: number;
}

function simulateScore(
  agent: AgentConfig,
  signal: SignalForSim,
  currentPrice: number,
  disclosureDate: string
): ScoreComponents | null {
  if (!agent.scoring) return null;

  const components = agent.scoring.components;
  let weightedSum = 0;
  let totalWeight = 0;

  const result: ScoreComponents = {
    time_decay: 0,
    price_movement: 0,
    position_size: 0,
    weighted_total: 0,
  };

  // Time decay
  if (components.time_decay) {
    const daysSinceTrade = daysBetween(signal.trade_date, disclosureDate);
    const decay = Math.pow(0.5, daysSinceTrade / components.time_decay.half_life_days);
    result.time_decay = decay;
    weightedSum += decay * components.time_decay.weight;
    totalWeight += components.time_decay.weight;
  }

  // Price movement
  if (components.price_movement) {
    const pct = Math.abs(((currentPrice - signal.trade_price) / signal.trade_price) * 100);
    const thresholds = components.price_movement.thresholds;
    let score: number;

    if (pct <= 0) score = thresholds.pct_0;
    else if (pct <= 5) score = lerp(thresholds.pct_0, thresholds.pct_5, pct / 5);
    else if (pct <= 15) score = lerp(thresholds.pct_5, thresholds.pct_15, (pct - 5) / 10);
    else if (pct <= 25) score = lerp(thresholds.pct_15, thresholds.pct_25, (pct - 15) / 10);
    else score = 0;

    result.price_movement = score;
    weightedSum += score * components.price_movement.weight;
    totalWeight += components.price_movement.weight;
  }

  // Position size
  if (components.position_size) {
    const size = signal.position_size_min;
    let idx = 0;
    for (let i = 0; i < components.position_size.thresholds.length; i++) {
      if (size >= components.position_size.thresholds[i]) {
        idx = i + 1;
      }
    }
    const score = components.position_size.scores[idx] ?? 0.5;
    result.position_size = score;
    weightedSum += score * components.position_size.weight;
    totalWeight += components.position_size.weight;
  }

  // Filing speed (Claude only)
  if (components.filing_speed) {
    const daysSinceFiling = daysBetween(signal.disclosure_date, disclosureDate);
    let score = 1.0;
    if (daysSinceFiling <= 7) score = 1.0 + components.filing_speed.fast_bonus;
    else if (daysSinceFiling >= 30) score = 1.0 + components.filing_speed.slow_penalty;
    result.filing_speed = score;
    weightedSum += score * components.filing_speed.weight;
    totalWeight += components.filing_speed.weight;
  }

  // Politician skill - use default (no DB access)
  if (components.politician_skill) {
    const score = components.politician_skill.default_score;
    weightedSum += score * components.politician_skill.weight;
    totalWeight += components.politician_skill.weight;
  }

  // Source quality - use default
  if (components.source_quality) {
    const score = components.source_quality.scores[signal.source] ?? components.source_quality.scores["default"] ?? 0.8;
    weightedSum += score * components.source_quality.weight;
    totalWeight += components.source_quality.weight;
  }

  result.weighted_total = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return result;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(Math.max(t, 0), 1);
}

// =============================================================================
// Filter Checks
// =============================================================================

interface FilterResult {
  passes: boolean;
  reason: SkipReason | null;
}

function checkFilters(
  agent: AgentConfig,
  signal: SignalForSim,
  currentPrice: number,
  disclosureDate: string
): FilterResult {
  // Politician whitelist
  if (agent.politician_whitelist) {
    const matches = agent.politician_whitelist.some(
      name => signal.politician_name.toLowerCase().includes(name.toLowerCase())
    );
    if (!matches) {
      return { passes: false, reason: "filter_politician" };
    }
  }

  // Asset type
  if (!agent.allowed_asset_types.includes(signal.asset_type as any)) {
    return { passes: false, reason: "filter_asset_type" };
  }

  // Signal age
  const daysSinceTrade = daysBetween(signal.trade_date, disclosureDate);
  if (daysSinceTrade > agent.max_signal_age_days) {
    return { passes: false, reason: "filter_age" };
  }

  // Price movement
  const priceMovePct = Math.abs(((currentPrice - signal.trade_price) / signal.trade_price) * 100);
  if (priceMovePct > agent.max_price_move_pct) {
    return { passes: false, reason: "filter_price_move" };
  }

  return { passes: true, reason: null };
}

// =============================================================================
// Table Formatting
// =============================================================================

function pad(str: string, len: number, right = false): string {
  if (right) return str.padEnd(len);
  return str.padStart(len);
}

function formatMove(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function formatMoney(amt: number): string {
  if (amt >= 1000) return `$${(amt / 1000).toFixed(0)}K`;
  return `$${amt.toFixed(0)}`;
}

// =============================================================================
// MAIN TEST
// =============================================================================

describe("Monthly Detail - Single Strategy Table", () => {
  it("should show ChatGPT decisions in table format", () => {
    runStrategyTable(CHATGPT_CONFIG, "2025-05");
  });

  it.skip("should show Claude decisions in table format", () => {
    runStrategyTable(CLAUDE_CONFIG, "2025-05");
  });

  it.skip("should show Gemini decisions in table format", () => {
    runStrategyTable(GEMINI_CONFIG, "2025-05");
  });

  it.skip("should show Naive decisions in table format", () => {
    runStrategyTable(NAIVE_CONFIG, "2025-05");
  });
});

function runStrategyTable(agent: AgentConfig, testMonth: string) {
  const MONTHLY_BUDGET = agent.monthly_budget;

  console.log("\n" + "=".repeat(140));
  console.log(`${agent.name.toUpperCase()} (${agent.id}) - ${testMonth}`);
  console.log("=".repeat(140));

  // Load signals
  const allSignals = loadRealSignals();
  const priceProvider = new SimplePriceProvider(allSignals as unknown as RealSignal[]);

  // Filter to this month
  const monthSignals = allSignals
    .filter(s => s.disclosure_date.startsWith(testMonth))
    .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date) || a.id.localeCompare(b.id));

  console.log(`\nSignals: ${monthSignals.length} | Budget: $${MONTHLY_BUDGET} | Mode: ${agent.sizing.mode}`);

  // Show bucket breakdown for smart_budget mode
  if (agent.sizing.mode === "smart_budget" && agent.sizing.bucket_config) {
    const breakdown = getSmartBudgetBreakdown(MONTHLY_BUDGET, agent.sizing.bucket_config);
    console.log(`\nBucket allocation:`);
    console.log(`  Small:  $${breakdown.small.budget.toFixed(0)} budget, $${breakdown.small.perTrade.toFixed(2)}/trade (${breakdown.small.expectedCount} expected)`);
    console.log(`  Medium: $${breakdown.medium.budget.toFixed(0)} budget, $${breakdown.medium.perTrade.toFixed(2)}/trade (${breakdown.medium.expectedCount} expected)`);
    console.log(`  Large:  $${breakdown.large.budget.toFixed(0)} budget, $${breakdown.large.perTrade.toFixed(2)}/trade (${breakdown.large.expectedCount} expected)`);
  }

  // Print table header
  console.log("\n" + "-".repeat(140));

  if (agent.scoring) {
    // Scoring agent header
    console.log(
      pad("#", 4) + " | " +
      pad("Date", 10, true) + " | " +
      pad("Ticker", 6, true) + " | " +
      pad("Politician", 18, true) + " | " +
      pad("Decision", 8, true) + " | " +
      pad("Reason", 12, true) + " | " +
      pad("Age", 3) + " | " +
      pad("Move", 7) + " | " +
      pad("Cong$", 6) + " | " +
      pad("Score", 5) + " | " +
      "td    pm    ps    | " +
      pad("Size$", 6)
    );
  } else {
    // Non-scoring agent header
    console.log(
      pad("#", 4) + " | " +
      pad("Date", 10, true) + " | " +
      pad("Ticker", 6, true) + " | " +
      pad("Politician", 18, true) + " | " +
      pad("Decision", 8, true) + " | " +
      pad("Reason", 12, true) + " | " +
      pad("Age", 3) + " | " +
      pad("Move", 7) + " | " +
      pad("Cong$", 6) + " | " +
      pad("Bucket", 8, true) + " | " +
      pad("Size$", 6)
    );
  }
  console.log("-".repeat(140));

  // Track budget
  let remainingBudget = MONTHLY_BUDGET;
  const bucketBudgets = agent.sizing.bucket_config
    ? {
        small: getSmartBudgetBreakdown(MONTHLY_BUDGET, agent.sizing.bucket_config).small.budget,
        medium: getSmartBudgetBreakdown(MONTHLY_BUDGET, agent.sizing.bucket_config).medium.budget,
        large: getSmartBudgetBreakdown(MONTHLY_BUDGET, agent.sizing.bucket_config).large.budget,
      }
    : null;

  let executed = 0;
  let skipped = 0;
  let totalInvested = 0;
  const skipReasons: Record<string, number> = {};

  for (let i = 0; i < monthSignals.length; i++) {
    const signal = monthSignals[i];
    const currentPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);

    if (currentPrice === null) {
      printRow(i + 1, signal, "SKIP", "No price", null, null, null, agent.scoring !== null);
      skipped++;
      skipReasons["no_price"] = (skipReasons["no_price"] || 0) + 1;
      continue;
    }

    const daysSinceTrade = daysBetween(signal.trade_date, signal.disclosure_date);
    const priceMovePct = ((currentPrice - signal.trade_price) / signal.trade_price) * 100;

    // Check filters
    const filterResult = checkFilters(agent, signal, currentPrice, signal.disclosure_date);
    if (!filterResult.passes && filterResult.reason) {
      const reason = filterResult.reason;
      printRow(i + 1, signal, "SKIP", getReasonDisplay(reason), daysSinceTrade, priceMovePct, null, agent.scoring !== null);
      skipped++;
      skipReasons[reason] = (skipReasons[reason] || 0) + 1;
      continue;
    }

    // Calculate score if applicable
    const scoreResult = simulateScore(agent, signal, currentPrice, signal.disclosure_date);
    const score = scoreResult?.weighted_total ?? null;

    // Check score threshold
    if (agent.scoring && score !== null && score < agent.execute_threshold) {
      const reason: SkipReason = "skip_score";
      printRow(i + 1, signal, "SKIP", getReasonDisplay(reason), daysSinceTrade, priceMovePct, scoreResult, agent.scoring !== null);
      skipped++;
      skipReasons[reason] = (skipReasons[reason] || 0) + 1;
      continue;
    }

    // Calculate position size
    let positionSize: number;

    if (agent.sizing.mode === "smart_budget" && bucketBudgets) {
      const bucket = getBucketForSize(agent.sizing.bucket_config!, signal.position_size_min);
      if (bucketBudgets[bucket] <= 0) {
        const reason: SkipReason = "skip_budget";
        printRowWithBucket(i + 1, signal, "SKIP", getReasonDisplay(reason), daysSinceTrade, priceMovePct, bucket, 0);
        skipped++;
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
        continue;
      }

      positionSize = calculatePositionSize(
        agent,
        score,
        { remaining: bucketBudgets[bucket] },
        1,
        false,
        signal.position_size_min
      );

      if (positionSize <= 0) {
        const reason: SkipReason = "skip_size_zero";
        printRowWithBucket(i + 1, signal, "SKIP", getReasonDisplay(reason), daysSinceTrade, priceMovePct, bucket, 0);
        skipped++;
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
        continue;
      }

      bucketBudgets[bucket] -= positionSize;
      printRowWithBucket(i + 1, signal, "EXEC", "", daysSinceTrade, priceMovePct, bucket, positionSize);
    } else {
      positionSize = calculatePositionSize(
        agent,
        score,
        { remaining: remainingBudget },
        1,
        false,
        signal.position_size_min
      );

      if (positionSize <= 0) {
        const reason: SkipReason = "skip_size_zero";
        printRow(i + 1, signal, "SKIP", getReasonDisplay(reason), daysSinceTrade, priceMovePct, scoreResult, agent.scoring !== null);
        skipped++;
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
        continue;
      }

      remainingBudget -= positionSize;
      printRow(i + 1, signal, "EXEC", "", daysSinceTrade, priceMovePct, scoreResult, agent.scoring !== null, positionSize);
    }

    executed++;
    totalInvested += positionSize;
  }

  // Summary
  console.log("-".repeat(140));
  console.log(`\nSUMMARY: ${executed} executed, ${skipped} skipped | Total invested: $${totalInvested.toFixed(2)}`);

  if (Object.keys(skipReasons).length > 0) {
    console.log("Skip reasons: " + Object.entries(skipReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => {
        // Use display name if it's a known skip reason, otherwise use raw string
        const display = reason === "no_price" ? "No price" : getReasonDisplay(reason as SkipReason);
        return `${display}(${count})`;
      })
      .join(", "));
  }

  if (bucketBudgets) {
    console.log(`Remaining budget: Small=$${bucketBudgets.small.toFixed(2)}, Medium=$${bucketBudgets.medium.toFixed(2)}, Large=$${bucketBudgets.large.toFixed(2)}`);
  } else {
    console.log(`Remaining budget: $${remainingBudget.toFixed(2)}`);
  }

  expect(monthSignals.length).toBeGreaterThan(0);
}

function printRow(
  num: number,
  signal: SignalForSim,
  decision: string,
  reason: string,
  age: number | null,
  move: number | null,
  scoreResult: ScoreComponents | null,
  hasScoring: boolean,
  size?: number
) {
  const row =
    pad(String(num), 4) + " | " +
    pad(signal.disclosure_date, 10, true) + " | " +
    pad(signal.ticker.slice(0, 6), 6, true) + " | " +
    pad(signal.politician_name.slice(0, 18), 18, true) + " | " +
    pad(decision, 8, true) + " | " +
    pad(reason.slice(0, 12), 12, true) + " | " +
    pad(age !== null ? String(age) : "-", 3) + " | " +
    pad(move !== null ? formatMove(move) : "-", 7) + " | " +
    pad(formatMoney(signal.position_size_min), 6) + " | ";

  if (hasScoring) {
    if (scoreResult) {
      const scoreStr = scoreResult.weighted_total.toFixed(3);
      const breakdown = `${scoreResult.time_decay.toFixed(2)}  ${scoreResult.price_movement.toFixed(2)}  ${scoreResult.position_size.toFixed(2)}`;
      console.log(row +
        pad(scoreStr, 5) + " | " +
        breakdown + " | " +
        pad(size ? `$${size.toFixed(0)}` : "-", 6)
      );
    } else {
      console.log(row + pad("-", 5) + " | " + "-".repeat(17) + " | " + pad("-", 6));
    }
  } else {
    console.log(row + pad("-", 8, true) + " | " + pad(size ? `$${size.toFixed(0)}` : "-", 6));
  }
}

function printRowWithBucket(
  num: number,
  signal: SignalForSim,
  decision: string,
  reason: string,
  age: number | null,
  move: number | null,
  bucket: "small" | "medium" | "large",
  size: number
) {
  const bucketLabel = bucket === "small" ? "S" : bucket === "medium" ? "M" : "L";

  console.log(
    pad(String(num), 4) + " | " +
    pad(signal.disclosure_date, 10, true) + " | " +
    pad(signal.ticker.slice(0, 6), 6, true) + " | " +
    pad(signal.politician_name.slice(0, 18), 18, true) + " | " +
    pad(decision, 8, true) + " | " +
    pad(reason.slice(0, 12), 12, true) + " | " +
    pad(age !== null ? String(age) : "-", 3) + " | " +
    pad(move !== null ? formatMove(move) : "-", 7) + " | " +
    pad(formatMoney(signal.position_size_min), 6) + " | " +
    pad(bucketLabel, 8, true) + " | " +
    pad(size > 0 ? `$${size.toFixed(0)}` : "-", 6)
  );
}
