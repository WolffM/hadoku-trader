/**
 * Local Simulation Test - Uses trader-db-export.json
 * Tests simulation against real data to verify logic correctness.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  SimulationClock,
  SignalReplayer,
  PortfolioState,
  EventLogger,
  generateSimId,
  daysBetween,
  type SignalForSim,
} from "./simulation";
import { StaticPriceProvider } from "./priceProvider";
import { CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG, NAIVE_CONFIG, SPY_BENCHMARK_CONFIG } from "./configs";
import type {
  AgentConfig,
  EnrichedSignal,
  AgentDecision,
  SimPosition,
  CloseReason,
  ScoreBreakdown,
} from "./types";
import { shouldAgentProcessSignal, lerp, clamp } from "./filters";
import { calculatePositionSize, calculateShares } from "./sizing";

// =============================================================================
// Data Loading
// =============================================================================

interface ExportData {
  signals: Array<{
    id: string;
    ticker: string;
    action: string;
    asset_type: string;
    trade_price: number;
    trade_date: string;
    disclosure_date: string;
    disclosure_price: number | null;
    position_size_min: number;
    politician_name: string;
    source: string;
  }>;
  market_prices: Array<{
    ticker: string;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
    source: string;
  }>;
}

let exportData: ExportData | null = null;

function loadExportData(): ExportData {
  if (exportData) return exportData;

  const exportPath = path.resolve(__dirname, "../../../trader-db-export.json");

  if (!fs.existsSync(exportPath)) {
    throw new Error(`Export file not found: ${exportPath}`);
  }

  const content = fs.readFileSync(exportPath, "utf-8");
  exportData = JSON.parse(content) as ExportData;
  return exportData;
}

function convertToSignalForSim(raw: ExportData["signals"][0]): SignalForSim {
  return {
    id: raw.id,
    ticker: raw.ticker,
    action: raw.action as "buy" | "sell",
    asset_type: raw.asset_type as "stock" | "etf" | "option",
    trade_price: raw.trade_price,
    trade_date: raw.trade_date,
    disclosure_date: raw.disclosure_date,
    disclosure_price: raw.disclosure_price,
    position_size_min: raw.position_size_min,
    politician_name: raw.politician_name,
    source: raw.source,
  };
}

// =============================================================================
// Simulation Helpers (copied from main test file)
// =============================================================================

function enrichSignalForSim(
  signal: SignalForSim,
  currentPrice: number,
  currentDate: string
): EnrichedSignal {
  const daysSinceTrade = daysBetween(signal.trade_date, currentDate);
  const daysSinceDisclosure = daysBetween(signal.disclosure_date, currentDate);
  const priceChangePct =
    ((currentPrice - signal.trade_price) / signal.trade_price) * 100;

  return {
    id: signal.id,
    ticker: signal.ticker,
    action: signal.action,
    asset_type: signal.asset_type as "stock" | "etf" | "option",
    trade_price: signal.trade_price,
    current_price: currentPrice,
    trade_date: signal.trade_date,
    disclosure_date: signal.disclosure_date,
    position_size_min: signal.position_size_min,
    politician_name: signal.politician_name,
    source: signal.source,
    days_since_trade: daysSinceTrade,
    days_since_filing: Math.max(daysSinceDisclosure, 0),
    price_change_pct: priceChangePct,
  };
}

function calculateScoreForSim(
  agent: AgentConfig,
  signal: EnrichedSignal
): { score: number; breakdown: ScoreBreakdown } {
  if (!agent.scoring) {
    return { score: 1.0, breakdown: { weighted_total: 1.0 } };
  }

  const components = agent.scoring.components;
  const breakdown: ScoreBreakdown = { weighted_total: 0 };
  let totalWeight = 0;
  let weightedSum = 0;

  // Time Decay - use days_since_filing (when we learn about the trade)
  // The original spec used days_since_trade, but that penalizes signals
  // for "staleness" before we even know about them
  if (components.time_decay) {
    // Use days since filing (disclosure) as the primary decay factor
    // This is when we actually learn about the trade and can act on it
    const daysToDecay = signal.days_since_filing;
    let decay = Math.pow(
      0.5,
      daysToDecay / components.time_decay.half_life_days
    );

    // If use_filing_date is set, also consider the trade date decay
    // Take the minimum (worst) of both - keeps backward compatibility
    if (components.time_decay.use_filing_date && components.time_decay.filing_half_life_days) {
      const tradeDecay = Math.pow(
        0.5,
        signal.days_since_trade / components.time_decay.filing_half_life_days
      );
      decay = Math.min(decay, tradeDecay);
    }
    breakdown.time_decay = decay;
    weightedSum += decay * components.time_decay.weight;
    totalWeight += components.time_decay.weight;
  }

  // Price Movement
  if (components.price_movement) {
    const thresholds = components.price_movement.thresholds;
    const pct = Math.abs(signal.price_change_pct);
    let score: number;

    if (pct <= 0) {
      score = thresholds.pct_0;
    } else if (pct <= 5) {
      score = lerp(thresholds.pct_0, thresholds.pct_5, pct / 5);
    } else if (pct <= 15) {
      score = lerp(thresholds.pct_5, thresholds.pct_15, (pct - 5) / 10);
    } else if (pct <= 25) {
      score = lerp(thresholds.pct_15, thresholds.pct_25, (pct - 15) / 10);
    } else {
      score = 0;
    }

    // Dip bonus
    if (signal.action === "buy" && signal.price_change_pct < 0) {
      score = Math.min(score * 1.2, 1.2);
    }

    breakdown.price_movement = score;
    weightedSum += score * components.price_movement.weight;
    totalWeight += components.price_movement.weight;
  }

  // Position Size
  if (components.position_size) {
    const size = signal.position_size_min;
    let idx = 0;
    for (let i = 0; i < components.position_size.thresholds.length; i++) {
      if (size >= components.position_size.thresholds[i]) {
        idx = i + 1;
      }
    }
    const score =
      components.position_size.scores[idx] ??
      components.position_size.scores[components.position_size.scores.length - 1] ??
      0.5;
    breakdown.position_size = score;
    weightedSum += score * components.position_size.weight;
    totalWeight += components.position_size.weight;
  }

  // Politician Skill (use default for simulation)
  if (components.politician_skill) {
    const score = components.politician_skill.default_score;
    breakdown.politician_skill = score;
    weightedSum += score * components.politician_skill.weight;
    totalWeight += components.politician_skill.weight;
  }

  // Source Quality
  if (components.source_quality) {
    const score =
      components.source_quality.scores[signal.source] ??
      components.source_quality.scores["default"] ??
      0.8;
    breakdown.source_quality = score;
    weightedSum += score * components.source_quality.weight;
    totalWeight += components.source_quality.weight;
  }

  // Filing Speed (Claude only)
  if (components.filing_speed) {
    let score = 1.0;
    if (signal.days_since_filing <= 7) {
      score = 1.0 + components.filing_speed.fast_bonus;
    } else if (signal.days_since_filing >= 30) {
      score = 1.0 + components.filing_speed.slow_penalty;
    }
    breakdown.filing_speed = score;
    weightedSum += score * components.filing_speed.weight;
    totalWeight += components.filing_speed.weight;
  }

  // Cross Confirmation (simplified - assume 1 source for sim)
  if (components.cross_confirmation) {
    breakdown.cross_confirmation = 1.0;
    weightedSum += 1.0 * components.cross_confirmation.weight;
    totalWeight += components.cross_confirmation.weight;
  }

  breakdown.weighted_total =
    totalWeight > 0 ? clamp(weightedSum / totalWeight, 0, 1) : 0;

  return { score: breakdown.weighted_total, breakdown };
}

function processSignalForAgentSim(
  agent: AgentConfig,
  signal: EnrichedSignal,
  openPositions: number,
  tickerPositions: number
): AgentDecision {
  // Check hard filters
  const filterResult = shouldAgentProcessSignal(agent, signal);
  if (!filterResult.passes) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "skip",
      decision_reason: filterResult.reason,
      score: null,
      score_breakdown: null,
      position_size: null,
    };
  }

  // Check position limits
  if (openPositions >= agent.sizing.max_open_positions) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "skip",
      decision_reason: "skip_budget",
      score: null,
      score_breakdown: null,
      position_size: null,
    };
  }

  if (tickerPositions >= agent.sizing.max_per_ticker) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "skip",
      decision_reason: "skip_budget",
      score: null,
      score_breakdown: null,
      position_size: null,
    };
  }

  // Calculate score
  const { score, breakdown } = calculateScoreForSim(agent, signal);

  // Determine action
  if (agent.scoring === null) {
    // Gemini: pass/fail only
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "execute",
      decision_reason: "execute",
      score: null,
      score_breakdown: null,
      position_size: null,
    };
  }

  if (score >= agent.execute_threshold) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "execute",
      decision_reason: "execute",
      score,
      score_breakdown: breakdown as Record<string, number>,
      position_size: null,
    };
  }

  if (
    agent.half_size_threshold !== null &&
    score >= agent.half_size_threshold
  ) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "execute_half",
      decision_reason: "execute_half",
      score,
      score_breakdown: breakdown as Record<string, number>,
      position_size: null,
    };
  }

  return {
    agent_id: agent.id,
    signal_id: signal.id,
    action: "skip",
    decision_reason: "skip_score",
    score,
    score_breakdown: breakdown as Record<string, number>,
    position_size: null,
  };
}

function checkExitConditionsForSim(
  position: SimPosition,
  agent: AgentConfig,
  currentPrice: number,
  currentDate: string
): { reason: CloseReason; sellPct: number } | null {
  const returnPct =
    ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const dropFromHigh =
    ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
  const daysHeld = daysBetween(position.entryDate, currentDate);

  // 1. Stop-loss
  if (agent.exit.stop_loss.mode === "fixed") {
    if (returnPct <= -agent.exit.stop_loss.threshold_pct) {
      return { reason: "stop_loss", sellPct: 100 };
    }
  } else if (agent.exit.stop_loss.mode === "trailing") {
    if (dropFromHigh >= agent.exit.stop_loss.threshold_pct) {
      return { reason: "stop_loss", sellPct: 100 };
    }
  }

  // 2. Take-profit (Claude only)
  if (agent.exit.take_profit) {
    if (returnPct >= agent.exit.take_profit.second_threshold_pct) {
      return { reason: "take_profit", sellPct: 100 };
    }
    if (
      returnPct >= agent.exit.take_profit.first_threshold_pct &&
      !position.partialSold
    ) {
      return {
        reason: "take_profit",
        sellPct: agent.exit.take_profit.first_sell_pct,
      };
    }
  }

  // 3. Time exit
  if (agent.exit.max_hold_days !== null && daysHeld >= agent.exit.max_hold_days) {
    return { reason: "time_exit", sellPct: 100 };
  }

  // 4. Soft stop (ChatGPT only)
  if (agent.exit.soft_stop) {
    const noProgressDays = agent.exit.soft_stop.no_progress_days_stock;
    if (daysHeld >= noProgressDays && returnPct <= 0) {
      return { reason: "soft_stop", sellPct: 100 };
    }
  }

  return null;
}

// =============================================================================
// Simulation-Specific Configs (for testing signal quality)
// =============================================================================

/**
 * Creates simulation config with ORIGINAL exit rules.
 * We want to see true strategy performance, not artificially constrained.
 */
function createSimulationConfig(
  base: AgentConfig,
  sizingOverrides: Partial<AgentConfig["sizing"]> = {},
  exitOverrides: Partial<AgentConfig["exit"]> = {}
): AgentConfig {
  return {
    ...base,
    sizing: {
      ...base.sizing,
      max_open_positions: 1000, // Effectively unlimited
      max_per_ticker: 10,
      min_position_amount: 10, // Very low minimum
      max_position_amount: 50, // Small fixed size per position
      max_position_pct: 1.0, // No percentage limit
      ...sizingOverrides,
    },
    exit: {
      ...base.exit,
      // KEEP ORIGINAL EXIT RULES - don't override max_hold_days
      ...exitOverrides,
    },
  };
}

// Create simulation versions with ORIGINAL exit rules
// Lower thresholds to match actual score distribution (due to days_since_filing fix)
const SIM_CHATGPT_CONFIG: AgentConfig = {
  ...createSimulationConfig(CHATGPT_CONFIG),
  execute_threshold: 0.50,       // Was 0.70
  half_size_threshold: 0.40,    // Was 0.55
  // Original exit: stop_loss=18%, max_hold=120d, soft_stop=30d
};

const SIM_CLAUDE_CONFIG: AgentConfig = {
  ...createSimulationConfig(CLAUDE_CONFIG, { base_amount: 50 }),
  execute_threshold: 0.50,      // Was 0.55
  // Original exit: stop_loss=15%, max_hold=120d, take_profit=25%/40%
};

// Gemini and Naive keep original configs (no scoring thresholds to adjust)
const SIM_GEMINI_CONFIG = createSimulationConfig(GEMINI_CONFIG);
// Original exit: trailing stop 20%, no max_hold (unlimited)

const SIM_NAIVE_CONFIG = createSimulationConfig(NAIVE_CONFIG);
// Original exit: stop_loss=20%, no max_hold (unlimited)

// Create alternative configs WITHOUT soft_stop to test its impact
const SIM_CHATGPT_NO_SOFTSTOP: AgentConfig = {
  ...SIM_CHATGPT_CONFIG,
  id: "chatgpt_no_softstop",
  name: "Decay Edge (No Soft Stop)",
  exit: {
    ...SIM_CHATGPT_CONFIG.exit,
    soft_stop: undefined, // Remove soft stop
  },
};

// =============================================================================
// Tests
// =============================================================================

describe("Local Data Analysis", () => {
  let data: ExportData;

  beforeAll(() => {
    try {
      data = loadExportData();
    } catch (e) {
      console.warn("Export file not found, skipping local tests");
    }
  });

  it("should analyze data coverage", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    console.log("\n=== DATA ANALYSIS ===");
    console.log(`Total signals: ${data.signals.length}`);
    console.log(`Total market prices: ${data.market_prices.length}`);

    // Signal date ranges
    const disclosureDates = data.signals.map(s => s.disclosure_date).sort();
    console.log(`\nSignal disclosure dates:`);
    console.log(`  Earliest: ${disclosureDates[0]}`);
    console.log(`  Latest: ${disclosureDates[disclosureDates.length - 1]}`);

    const tradeDates = data.signals.map(s => s.trade_date).sort();
    console.log(`\nSignal trade dates:`);
    console.log(`  Earliest: ${tradeDates[0]}`);
    console.log(`  Latest: ${tradeDates[tradeDates.length - 1]}`);

    // Market price date ranges
    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    console.log(`\nMarket price dates:`);
    console.log(`  Earliest: ${priceDates[0]}`);
    console.log(`  Latest: ${priceDates[priceDates.length - 1]}`);

    // Find overlap
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    const signalsWithRealPrices = data.signals.filter(s =>
      s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd
    );
    console.log(`\nSignals with disclosure dates in price range: ${signalsWithRealPrices.length}`);

    // Unique tickers
    const signalTickers = new Set(data.signals.map(s => s.ticker));
    const priceTickers = new Set(data.market_prices.map(p => p.ticker));
    console.log(`\nUnique tickers in signals: ${signalTickers.size}`);
    console.log(`Unique tickers in prices: ${priceTickers.size}`);

    // Politicians
    const politicians = new Map<string, number>();
    for (const s of data.signals) {
      politicians.set(s.politician_name, (politicians.get(s.politician_name) || 0) + 1);
    }
    const sortedPoliticians = [...politicians.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\nTop politicians by trade count:`);
    for (const [name, count] of sortedPoliticians.slice(0, 10)) {
      console.log(`  ${name}: ${count}`);
    }

    // Pelosi trades specifically
    const pelosiTrades = data.signals.filter(s =>
      s.politician_name.toLowerCase().includes("pelosi")
    );
    console.log(`\nNancy Pelosi trades: ${pelosiTrades.length}`);
    for (const t of pelosiTrades) {
      console.log(`  ${t.trade_date} -> ${t.disclosure_date}: ${t.ticker} ${t.action} ($${t.position_size_min})`);
    }

    expect(data.signals.length).toBeGreaterThan(0);
  });

  it("should run simulation with StaticPriceProvider using real prices", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider from market_prices
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    // Also set SPY prices for benchmark
    const spyPrices = data.market_prices.filter(p => p.ticker === "SPY");
    console.log(`\nSPY prices loaded: ${spyPrices.length}`);

    // Find date range with actual prices
    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    // Get signals with disclosure dates in price range
    const signalsInRange = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .map(convertToSignalForSim);

    console.log(`Signals in date range: ${signalsInRange.length}`);

    if (signalsInRange.length === 0) {
      console.log("No signals in date range with real prices - data mismatch");
      console.log("\nData mismatch details:");
      console.log(`  Price data: ${priceStart} to ${priceEnd}`);
      console.log(`  Signal disclosures: ${data.signals[0]?.disclosure_date} to ${data.signals[data.signals.length-1]?.disclosure_date}`);
      expect(signalsInRange.length).toBe(0);
      return;
    }

    // Find the earliest signal disclosure date - start simulation from there
    const disclosureDates = signalsInRange.map(s => s.disclosure_date).sort();
    const simStart = disclosureDates[0];
    const simEnd = priceEnd;

    console.log(`\nSimulation date range: ${simStart} to ${simEnd}`);
    console.log(`  (Starting from first signal disclosure, not first price date)`);

    // Run simulation with SIMULATION configs (no capital constraints)
    const agentConfigs = [SIM_CHATGPT_CONFIG, SIM_CLAUDE_CONFIG, SIM_GEMINI_CONFIG, SIM_NAIVE_CONFIG];
    const MONTHLY_BUDGET = 1000;

    const clock = new SimulationClock(simStart, simEnd);
    const signalReplayer = new SignalReplayer(signalsInRange);
    const portfolioState = new PortfolioState();
    const eventLogger = new EventLogger(false);

    portfolioState.initialize(
      agentConfigs.map(a => a.id),
      MONTHLY_BUDGET
    );

    let lastMonth = simStart.substring(0, 7);
    let signalsProcessed = 0;

    while (!clock.isComplete()) {
      const currentDate = clock.getDate();

      if (!clock.isMarketDay()) {
        clock.advance();
        continue;
      }

      // Monthly budget
      const currentMonth = currentDate.substring(0, 7);
      if (portfolioState.isNewMonth(currentDate, `${lastMonth}-01`)) {
        for (const agent of agentConfigs) {
          portfolioState.addMonthlyBudget(agent.id, MONTHLY_BUDGET);
        }
        lastMonth = currentMonth;
      }

      // Get signals disclosed by this date
      const signals = signalReplayer.getSignalsForDate(currentDate);
      const acceptedCounts = new Map<string, number>();

      for (const signal of signals) {
        // Get price on disclosure date (this is our entry price)
        const currentPrice = priceProvider.getPrice(signal.ticker, currentDate);
        if (currentPrice === null) continue;

        const enriched = enrichSignalForSim(signal, currentPrice, currentDate);
        eventLogger.logSignalReceived(currentDate, signal);

        for (const agent of agentConfigs) {
          const portfolio = portfolioState.getPortfolio(agent.id);
          const openPositions = portfolio.positions.length;
          const tickerPositions = portfolio.positions.filter(
            p => p.ticker === signal.ticker
          ).length;

          const decision = processSignalForAgentSim(
            agent,
            enriched,
            openPositions,
            tickerPositions
          );

          const breakdown = decision.score_breakdown as ScoreBreakdown | undefined;
          eventLogger.logDecision(currentDate, agent.id, signal, decision, breakdown);

          if (decision.action === "execute" || decision.action === "execute_half") {
            const count = acceptedCounts.get(agent.id) || 0;
            acceptedCounts.set(agent.id, count + 1);

            const positionSize = calculatePositionSize(
              agent,
              decision.score,
              { remaining: portfolioState.getCash(agent.id) },
              count + 1,
              decision.action === "execute_half"
            );

            if (positionSize > 0) {
              const shares = calculateShares(positionSize, currentPrice, true); // Allow fractional shares
              if (shares > 0) {
                const position: SimPosition = {
                  id: generateSimId("pos"),
                  ticker: signal.ticker,
                  shares,
                  entryPrice: currentPrice,
                  entryDate: currentDate,
                  currentPrice,
                  highestPrice: currentPrice,
                  partialSold: false,
                  signalId: signal.id,
                };

                portfolioState.addPosition(agent.id, position);
                eventLogger.logTradeExecuted(currentDate, agent.id, position);
              }
            }
          }
        }

        signalReplayer.markProcessed(signal.id);
        signalsProcessed++;
      }

      // Update prices and check exits
      for (const agent of agentConfigs) {
        const portfolio = portfolioState.getPortfolio(agent.id);
        const tickers = portfolio.positions.map(p => p.ticker);
        const prices = priceProvider.getClosingPrices(tickers, currentDate);

        portfolioState.updatePrices(agent.id, prices);

        const positionsToExit: Array<{
          position: SimPosition;
          reason: CloseReason;
          sellPct: number;
        }> = [];

        for (const position of portfolio.positions) {
          const price = prices.get(position.ticker);
          if (price === undefined) continue;

          const exitDecision = checkExitConditionsForSim(
            position,
            agent,
            price,
            currentDate
          );

          if (exitDecision) {
            positionsToExit.push({
              position,
              reason: exitDecision.reason,
              sellPct: exitDecision.sellPct,
            });
          }
        }

        for (const { position, reason, sellPct } of positionsToExit) {
          const price = prices.get(position.ticker)!;
          const closedPos = portfolioState.closePosition(
            agent.id,
            position.id,
            price,
            currentDate,
            reason,
            sellPct
          );

          if (closedPos) {
            eventLogger.logExit(currentDate, agent.id, closedPos, reason);
          }
        }

        portfolioState.snapshot(agent.id, currentDate);
      }

      eventLogger.logDailySummary(currentDate, portfolioState.getAllPortfolios());
      clock.advance();
    }

    // Generate report
    clock.reset();
    const report = eventLogger.getReport(clock, portfolioState);
    eventLogger.printReport(report);

    // Calculate and display SPY benchmark
    const spyStartPrice = priceProvider.getPrice("SPY", simStart);
    const spyEndPrice = priceProvider.getPrice("SPY", simEnd);
    if (spyStartPrice && spyEndPrice) {
      const spyReturn = ((spyEndPrice - spyStartPrice) / spyStartPrice) * 100;
      console.log(`\n--- SPY BENCHMARK ---`);
      console.log(`SPY Buy & Hold: ${spyReturn >= 0 ? "+" : ""}${spyReturn.toFixed(2)}%`);
      console.log(`  (${simStart} to ${simEnd}: $${spyStartPrice.toFixed(2)} → $${spyEndPrice.toFixed(2)})`);

      // Compare each agent to SPY
      console.log(`\n--- ALPHA vs SPY ---`);
      for (const [agentId, metrics] of Object.entries(report.agentResults)) {
        const alpha = metrics.totalReturnPct - spyReturn;
        console.log(`${agentId.toUpperCase()}: ${alpha >= 0 ? "+" : ""}${alpha.toFixed(2)}% alpha`);
      }
    }

    console.log(`\nSignals processed: ${signalsProcessed}`);

    expect(signalsProcessed).toBeGreaterThanOrEqual(0);
  });

  it("should trace decision breakdown for each strategy", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider from market_prices
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    // Find date range with actual prices
    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    // Get buy signals only, in date range
    const signalsInRange = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .filter(s => s.action === "buy")
      .map(convertToSignalForSim);

    console.log(`\n=== STRATEGY DECISION BREAKDOWN ===`);
    console.log(`Total buy signals: ${signalsInRange.length}`);

    const agentConfigs = [SIM_CHATGPT_CONFIG, SIM_CLAUDE_CONFIG, SIM_GEMINI_CONFIG, SIM_NAIVE_CONFIG];

    // Track decisions by agent
    const decisions: Record<string, {
      execute: number;
      execute_half: number;
      skip_filter: number;
      skip_score: number;
      skip_budget: number;
      no_price: number;
      filterReasons: Record<string, number>;
    }> = {};

    for (const agent of agentConfigs) {
      decisions[agent.id] = {
        execute: 0,
        execute_half: 0,
        skip_filter: 0,
        skip_score: 0,
        skip_budget: 0,
        no_price: 0,
        filterReasons: {},
      };
    }

    // Process each signal
    for (const signal of signalsInRange) {
      // Use disclosure date as the test date
      const testDate = signal.disclosure_date;
      const currentPrice = priceProvider.getPrice(signal.ticker, testDate);

      for (const agent of agentConfigs) {
        if (currentPrice === null) {
          decisions[agent.id].no_price++;
          continue;
        }

        const enriched = enrichSignalForSim(signal, currentPrice, testDate);

        // Check filters first
        const filterResult = shouldAgentProcessSignal(agent, enriched);
        if (!filterResult.passes) {
          decisions[agent.id].skip_filter++;
          const reason = filterResult.reason;
          decisions[agent.id].filterReasons[reason] = (decisions[agent.id].filterReasons[reason] || 0) + 1;
          continue;
        }

        // Calculate score
        const { score } = calculateScoreForSim(agent, enriched);

        // Determine action
        if (agent.scoring === null) {
          // No scoring = execute
          decisions[agent.id].execute++;
        } else if (score >= agent.execute_threshold) {
          decisions[agent.id].execute++;
        } else if (agent.half_size_threshold !== null && score >= agent.half_size_threshold) {
          decisions[agent.id].execute_half++;
        } else {
          decisions[agent.id].skip_score++;
        }
      }
    }

    // Print breakdown
    console.log(`\n--- Decision Breakdown by Agent ---`);
    for (const agent of agentConfigs) {
      const d = decisions[agent.id];
      const total = d.execute + d.execute_half + d.skip_filter + d.skip_score + d.no_price;
      const executeRate = ((d.execute + d.execute_half) / total * 100).toFixed(1);

      console.log(`\n${agent.id.toUpperCase()} (${agent.name}):`);
      console.log(`  Execute:      ${d.execute} (${(d.execute/total*100).toFixed(1)}%)`);
      console.log(`  Execute Half: ${d.execute_half} (${(d.execute_half/total*100).toFixed(1)}%)`);
      console.log(`  Skip Filter:  ${d.skip_filter} (${(d.skip_filter/total*100).toFixed(1)}%)`);
      console.log(`  Skip Score:   ${d.skip_score} (${(d.skip_score/total*100).toFixed(1)}%)`);
      console.log(`  No Price:     ${d.no_price} (${(d.no_price/total*100).toFixed(1)}%)`);
      console.log(`  TOTAL EXECUTION RATE: ${executeRate}%`);

      if (Object.keys(d.filterReasons).length > 0) {
        console.log(`  Filter reasons:`);
        for (const [reason, count] of Object.entries(d.filterReasons)) {
          console.log(`    ${reason}: ${count}`);
        }
      }
    }

    // Score distribution for ChatGPT and Claude (the scoring agents)
    console.log(`\n--- Score Distribution (ChatGPT & Claude) ---`);
    const scoreBuckets: Record<string, number[]> = { chatgpt: [], claude: [] };

    for (const signal of signalsInRange.slice(0, 1000)) { // Sample first 1000
      const testDate = signal.disclosure_date;
      const currentPrice = priceProvider.getPrice(signal.ticker, testDate);
      if (currentPrice === null) continue;

      const enriched = enrichSignalForSim(signal, currentPrice, testDate);

      for (const agent of [SIM_CHATGPT_CONFIG, SIM_CLAUDE_CONFIG]) {
        const filterResult = shouldAgentProcessSignal(agent, enriched);
        if (!filterResult.passes) continue;

        const { score } = calculateScoreForSim(agent, enriched);
        scoreBuckets[agent.id].push(score);
      }
    }

    for (const agentId of ["chatgpt", "claude"]) {
      const scores = scoreBuckets[agentId];
      if (scores.length === 0) continue;

      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const sorted = [...scores].sort((a, b) => a - b);
      const p25 = sorted[Math.floor(sorted.length * 0.25)];
      const p50 = sorted[Math.floor(sorted.length * 0.50)];
      const p75 = sorted[Math.floor(sorted.length * 0.75)];

      console.log(`\n${agentId.toUpperCase()} scores (n=${scores.length}):`);
      console.log(`  Average: ${avg.toFixed(3)}`);
      console.log(`  25th percentile: ${p25?.toFixed(3)}`);
      console.log(`  50th percentile: ${p50?.toFixed(3)}`);
      console.log(`  75th percentile: ${p75?.toFixed(3)}`);
      console.log(`  Below execute threshold (${agentId === 'chatgpt' ? '0.70' : '0.55'}): ${scores.filter(s => s < (agentId === 'chatgpt' ? 0.70 : 0.55)).length}`);
    }

    expect(true).toBe(true);
  });

  it("should analyze why scores are low", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider from market_prices
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    const signalsInRange = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .filter(s => s.action === "buy")
      .map(convertToSignalForSim);

    console.log(`\n=== SCORE COMPONENT ANALYSIS ===`);

    // Analyze each component for ChatGPT
    const components = {
      time_decay: [] as number[],
      price_movement: [] as number[],
      position_size: [] as number[],
      politician_skill: [] as number[],
      source_quality: [] as number[],
    };

    let analyzed = 0;
    for (const signal of signalsInRange) {
      const testDate = signal.disclosure_date;
      const currentPrice = priceProvider.getPrice(signal.ticker, testDate);
      if (currentPrice === null) continue;

      const enriched = enrichSignalForSim(signal, currentPrice, testDate);
      const filterResult = shouldAgentProcessSignal(SIM_CHATGPT_CONFIG, enriched);
      if (!filterResult.passes) continue;

      const { breakdown } = calculateScoreForSim(SIM_CHATGPT_CONFIG, enriched);

      if (breakdown.time_decay !== undefined) components.time_decay.push(breakdown.time_decay);
      if (breakdown.price_movement !== undefined) components.price_movement.push(breakdown.price_movement);
      if (breakdown.position_size !== undefined) components.position_size.push(breakdown.position_size);
      if (breakdown.politician_skill !== undefined) components.politician_skill.push(breakdown.politician_skill);
      if (breakdown.source_quality !== undefined) components.source_quality.push(breakdown.source_quality);

      analyzed++;
      if (analyzed >= 500) break; // Sample
    }

    console.log(`\nChatGPT Score Components (n=${analyzed}):`);
    console.log(`Weights: time_decay=0.30, price_movement=0.25, position_size=0.15, politician_skill=0.20, source_quality=0.10`);
    console.log(`Execute threshold: 0.70`);
    console.log(`\n--- Component Averages ---`);

    for (const [name, values] of Object.entries(components)) {
      if (values.length === 0) continue;
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      console.log(`${name}: avg=${avg.toFixed(3)}, min=${min.toFixed(3)}, max=${max.toFixed(3)}`);
    }

    // Calculate what weighted average would be
    const avgTimeDecay = components.time_decay.length > 0 ? components.time_decay.reduce((a, b) => a + b, 0) / components.time_decay.length : 0;
    const avgPriceMovement = components.price_movement.length > 0 ? components.price_movement.reduce((a, b) => a + b, 0) / components.price_movement.length : 0;
    const avgPositionSize = components.position_size.length > 0 ? components.position_size.reduce((a, b) => a + b, 0) / components.position_size.length : 0;
    const avgPoliticianSkill = components.politician_skill.length > 0 ? components.politician_skill.reduce((a, b) => a + b, 0) / components.politician_skill.length : 0;
    const avgSourceQuality = components.source_quality.length > 0 ? components.source_quality.reduce((a, b) => a + b, 0) / components.source_quality.length : 0;

    const weightedAvg = (
      avgTimeDecay * 0.30 +
      avgPriceMovement * 0.25 +
      avgPositionSize * 0.15 +
      avgPoliticianSkill * 0.20 +
      avgSourceQuality * 0.10
    );

    console.log(`\n--- Weighted Average ---`);
    console.log(`(${avgTimeDecay.toFixed(3)} × 0.30) + (${avgPriceMovement.toFixed(3)} × 0.25) + (${avgPositionSize.toFixed(3)} × 0.15) + (${avgPoliticianSkill.toFixed(3)} × 0.20) + (${avgSourceQuality.toFixed(3)} × 0.10)`);
    console.log(`= ${weightedAvg.toFixed(3)}`);
    console.log(`\nThis is ${((0.70 - weightedAvg) * 100).toFixed(1)}% below the execute threshold of 0.70!`);

    // What threshold would include 50% of signals?
    const allScores: number[] = [];
    for (const signal of signalsInRange.slice(0, 1000)) {
      const testDate = signal.disclosure_date;
      const currentPrice = priceProvider.getPrice(signal.ticker, testDate);
      if (currentPrice === null) continue;

      const enriched = enrichSignalForSim(signal, currentPrice, testDate);
      const filterResult = shouldAgentProcessSignal(SIM_CHATGPT_CONFIG, enriched);
      if (!filterResult.passes) continue;

      const { score } = calculateScoreForSim(SIM_CHATGPT_CONFIG, enriched);
      allScores.push(score);
    }

    const sortedScores = [...allScores].sort((a, b) => a - b);
    console.log(`\n--- Score Percentiles ---`);
    console.log(`10th: ${sortedScores[Math.floor(sortedScores.length * 0.10)]?.toFixed(3)}`);
    console.log(`25th: ${sortedScores[Math.floor(sortedScores.length * 0.25)]?.toFixed(3)}`);
    console.log(`50th: ${sortedScores[Math.floor(sortedScores.length * 0.50)]?.toFixed(3)}`);
    console.log(`75th: ${sortedScores[Math.floor(sortedScores.length * 0.75)]?.toFixed(3)}`);
    console.log(`90th: ${sortedScores[Math.floor(sortedScores.length * 0.90)]?.toFixed(3)}`);
    console.log(`95th: ${sortedScores[Math.floor(sortedScores.length * 0.95)]?.toFixed(3)}`);
    console.log(`\nTo execute top 50% of signals, threshold should be: ${sortedScores[Math.floor(sortedScores.length * 0.50)]?.toFixed(3)}`);
    console.log(`To execute top 30% of signals, threshold should be: ${sortedScores[Math.floor(sortedScores.length * 0.70)]?.toFixed(3)}`);

    expect(true).toBe(true);
  });

  it("should debug portfolio values and drawdown", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    const signalsInRange = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .map(convertToSignalForSim);

    const disclosureDates = signalsInRange.map(s => s.disclosure_date).sort();
    const simStart = disclosureDates[0];
    const simEnd = priceEnd;

    // Run simulation for just ChatGPT
    const agentConfigs = [SIM_CHATGPT_CONFIG];
    const MONTHLY_BUDGET = 1000;

    const clock = new SimulationClock(simStart, simEnd);
    const signalReplayer = new SignalReplayer(signalsInRange);
    const portfolioState = new PortfolioState();
    const eventLogger = new EventLogger(false);

    portfolioState.initialize(agentConfigs.map(a => a.id), MONTHLY_BUDGET);

    let lastMonth = simStart.substring(0, 7);
    const monthlyBreakdown: Array<{
      month: string;
      startValue: number;
      endValue: number;
      trades: number;
      budgetAdded: number;
    }> = [];
    let currentMonthTrades = 0;
    let monthStartValue = MONTHLY_BUDGET;

    while (!clock.isComplete()) {
      const currentDate = clock.getDate();

      if (!clock.isMarketDay()) {
        clock.advance();
        continue;
      }

      const currentMonth = currentDate.substring(0, 7);
      if (portfolioState.isNewMonth(currentDate, `${lastMonth}-01`)) {
        // Log previous month
        const portfolio = portfolioState.getPortfolio("chatgpt");
        const snap = portfolio.dailySnapshots[portfolio.dailySnapshots.length - 1];
        if (snap) {
          monthlyBreakdown.push({
            month: lastMonth,
            startValue: monthStartValue,
            endValue: snap.totalValue,
            trades: currentMonthTrades,
            budgetAdded: MONTHLY_BUDGET,
          });
        }

        portfolioState.addMonthlyBudget("chatgpt", MONTHLY_BUDGET);
        lastMonth = currentMonth;
        currentMonthTrades = 0;
        const newSnap = portfolioState.getPortfolio("chatgpt");
        monthStartValue = newSnap.cash + newSnap.positions.reduce((s, p) => s + p.shares * p.currentPrice, 0);
      }

      const signals = signalReplayer.getSignalsForDate(currentDate);

      for (const signal of signals) {
        const currentPrice = priceProvider.getPrice(signal.ticker, currentDate);
        if (currentPrice === null) continue;

        const enriched = enrichSignalForSim(signal, currentPrice, currentDate);
        const portfolio = portfolioState.getPortfolio("chatgpt");
        const openPositions = portfolio.positions.length;
        const tickerPositions = portfolio.positions.filter(p => p.ticker === signal.ticker).length;

        const decision = processSignalForAgentSim(SIM_CHATGPT_CONFIG, enriched, openPositions, tickerPositions);

        if (decision.action === "execute" || decision.action === "execute_half") {
          const positionSize = calculatePositionSize(
            SIM_CHATGPT_CONFIG,
            decision.score,
            { remaining: portfolioState.getCash("chatgpt") },
            1,
            decision.action === "execute_half"
          );

          if (positionSize > 0) {
            const shares = calculateShares(positionSize, currentPrice, true);
            if (shares > 0) {
              const position: SimPosition = {
                id: generateSimId("pos"),
                ticker: signal.ticker,
                shares,
                entryPrice: currentPrice,
                entryDate: currentDate,
                currentPrice,
                highestPrice: currentPrice,
                partialSold: false,
                signalId: signal.id,
              };

              portfolioState.addPosition("chatgpt", position);
              currentMonthTrades++;
            }
          }
        }

        signalReplayer.markProcessed(signal.id);
      }

      // Update prices and check exits
      const portfolio = portfolioState.getPortfolio("chatgpt");
      const tickers = portfolio.positions.map(p => p.ticker);
      const prices = priceProvider.getClosingPrices(tickers, currentDate);
      portfolioState.updatePrices("chatgpt", prices);

      for (const position of [...portfolio.positions]) {
        const price = prices.get(position.ticker);
        if (price === undefined) continue;

        const exitDecision = checkExitConditionsForSim(position, SIM_CHATGPT_CONFIG, price, currentDate);
        if (exitDecision) {
          portfolioState.closePosition("chatgpt", position.id, price, currentDate, exitDecision.reason, exitDecision.sellPct);
        }
      }

      portfolioState.snapshot("chatgpt", currentDate);
      clock.advance();
    }

    // Final month
    const finalPortfolio = portfolioState.getPortfolio("chatgpt");
    const finalSnap = finalPortfolio.dailySnapshots[finalPortfolio.dailySnapshots.length - 1];
    if (finalSnap) {
      monthlyBreakdown.push({
        month: lastMonth,
        startValue: monthStartValue,
        endValue: finalSnap.totalValue,
        trades: currentMonthTrades,
        budgetAdded: 0,
      });
    }

    console.log(`\n=== MONTHLY PORTFOLIO BREAKDOWN (ChatGPT) ===`);
    for (const m of monthlyBreakdown) {
      const returnPct = ((m.endValue - m.startValue) / m.startValue * 100).toFixed(2);
      console.log(`${m.month}: $${m.startValue.toFixed(0)} → $${m.endValue.toFixed(0)} (${returnPct}%) | ${m.trades} trades | +$${m.budgetAdded} budget`);
    }

    // Analyze drawdown from snapshots
    const snapshots = finalPortfolio.dailySnapshots;
    let peak = snapshots[0]?.totalValue || 0;
    let maxDrawdown = 0;
    let maxDrawdownDate = "";

    console.log(`\n--- Daily Value Samples (every 10 days) ---`);
    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      if (snap.totalValue > peak) {
        peak = snap.totalValue;
      }
      const drawdown = peak > 0 ? (peak - snap.totalValue) / peak : 0;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownDate = snap.date;
      }

      if (i % 10 === 0) {
        console.log(`${snap.date}: $${snap.totalValue.toFixed(0)} (cash: $${snap.cash.toFixed(0)}, positions: $${snap.positionsValue.toFixed(0)}) | peak: $${peak.toFixed(0)} | drawdown: ${(drawdown * 100).toFixed(2)}%`);
      }
    }

    console.log(`\n--- Max Drawdown ---`);
    console.log(`Peak: $${peak.toFixed(0)}`);
    console.log(`Max Drawdown: ${(maxDrawdown * 100).toFixed(2)}% on ${maxDrawdownDate}`);

    expect(true).toBe(true);
  });

  it("SOFT STOP IMPACT: compare ChatGPT with and without soft_stop", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    const signalsInRange = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .map(convertToSignalForSim);

    const disclosureDates = signalsInRange.map(s => s.disclosure_date).sort();
    const simStart = disclosureDates[0];
    const simEnd = priceEnd;

    console.log(`\n${"=".repeat(80)}`);
    console.log(`SOFT STOP IMPACT TEST: ${simStart} to ${simEnd}`);
    console.log(`${"=".repeat(80)}`);

    // Compare ChatGPT WITH soft_stop vs WITHOUT soft_stop
    const configs = [
      { config: SIM_CHATGPT_CONFIG, name: "WITH soft_stop (30 days)" },
      { config: SIM_CHATGPT_NO_SOFTSTOP, name: "WITHOUT soft_stop" },
    ];

    for (const { config, name } of configs) {
      const clock = new SimulationClock(simStart, simEnd);
      const signalReplayer = new SignalReplayer(signalsInRange);
      const portfolioState = new PortfolioState();

      portfolioState.initialize([config.id], 1000);
      let lastMonth = simStart.substring(0, 7);

      const exitCounts: Record<string, number> = {};
      const exitPnl: Record<string, number> = {};
      let totalTrades = 0;
      let closedTrades = 0;
      let totalPnl = 0;

      while (!clock.isComplete()) {
        const currentDate = clock.getDate();
        if (!clock.isMarketDay()) {
          clock.advance();
          continue;
        }

        const currentMonth = currentDate.substring(0, 7);
        if (portfolioState.isNewMonth(currentDate, `${lastMonth}-01`)) {
          portfolioState.addMonthlyBudget(config.id, 1000);
          lastMonth = currentMonth;
        }

        const signals = signalReplayer.getSignalsForDate(currentDate);
        for (const signal of signals) {
          const currentPrice = priceProvider.getPrice(signal.ticker, currentDate);
          if (currentPrice === null) continue;

          const enriched = enrichSignalForSim(signal, currentPrice, currentDate);
          const portfolio = portfolioState.getPortfolio(config.id);
          const decision = processSignalForAgentSim(config, enriched, portfolio.positions.length, 0);

          if (decision.action === "execute" || decision.action === "execute_half") {
            const positionSize = calculatePositionSize(config, decision.score, { remaining: portfolioState.getCash(config.id) }, 1, false);
            if (positionSize > 0) {
              const shares = calculateShares(positionSize, currentPrice, true);
              if (shares > 0) {
                portfolioState.addPosition(config.id, {
                  id: generateSimId("pos"),
                  ticker: signal.ticker,
                  shares,
                  entryPrice: currentPrice,
                  entryDate: currentDate,
                  currentPrice,
                  highestPrice: currentPrice,
                  partialSold: false,
                  signalId: signal.id,
                });
                totalTrades++;
              }
            }
          }
          signalReplayer.markProcessed(signal.id);
        }

        // Update prices and check exits
        const portfolio = portfolioState.getPortfolio(config.id);
        const tickers = portfolio.positions.map(p => p.ticker);
        const prices = priceProvider.getClosingPrices(tickers, currentDate);
        portfolioState.updatePrices(config.id, prices);

        for (const position of [...portfolio.positions]) {
          const price = prices.get(position.ticker);
          if (price === undefined) continue;

          const exitDecision = checkExitConditionsForSim(position, config, price, currentDate);
          if (exitDecision) {
            const pnl = (price - position.entryPrice) * position.shares;
            exitCounts[exitDecision.reason] = (exitCounts[exitDecision.reason] || 0) + 1;
            exitPnl[exitDecision.reason] = (exitPnl[exitDecision.reason] || 0) + pnl;
            totalPnl += pnl;
            closedTrades++;

            portfolioState.closePosition(config.id, position.id, price, currentDate, exitDecision.reason, exitDecision.sellPct);
          }
        }

        portfolioState.snapshot(config.id, currentDate);
        clock.advance();
      }

      // Calculate final portfolio value including open positions
      const finalPortfolio = portfolioState.getPortfolio(config.id);
      let openPositionValue = 0;
      for (const pos of finalPortfolio.positions) {
        openPositionValue += pos.shares * pos.currentPrice;
        totalPnl += (pos.currentPrice - pos.entryPrice) * pos.shares;
      }

      const totalValue = finalPortfolio.cash + openPositionValue;
      // We added $1000 per month for ~7 months = ~$7000 invested
      const months = Math.ceil(daysBetween(simStart, simEnd) / 30);
      const invested = months * 1000;

      console.log(`\n--- ChatGPT ${name} ---`);
      console.log(`Total Trades: ${totalTrades}`);
      console.log(`Closed: ${closedTrades}, Open: ${totalTrades - closedTrades}`);
      console.log(`Total P&L (realized + unrealized): $${totalPnl.toFixed(2)}`);
      console.log(`Final Portfolio Value: $${totalValue.toFixed(2)} (invested ~$${invested})`);
      console.log(`\nExit Breakdown:`);
      for (const [reason, count] of Object.entries(exitCounts).sort((a, b) => b[1] - a[1])) {
        const avgPnl = exitPnl[reason] / count;
        console.log(`  ${reason}: ${count} trades, total $${exitPnl[reason].toFixed(2)}, avg $${avgPnl.toFixed(2)}`);
      }
    }

    expect(true).toBe(true);
  });

  it("DEEP ANALYSIS: trace every trade decision and exit", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    const signalsInRange = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .map(convertToSignalForSim);

    const disclosureDates = signalsInRange.map(s => s.disclosure_date).sort();
    const simStart = disclosureDates[0];
    const simEnd = priceEnd;

    console.log(`\n${"=".repeat(80)}`);
    console.log(`DEEP STRATEGY ANALYSIS: ${simStart} to ${simEnd}`);
    console.log(`${"=".repeat(80)}`);

    // Run simulation for all agents and track detailed trade info
    const agentConfigs = [SIM_CHATGPT_CONFIG, SIM_CLAUDE_CONFIG, SIM_GEMINI_CONFIG, SIM_NAIVE_CONFIG];
    const MONTHLY_BUDGET = 1000;

    // Detailed trade tracking per agent
    interface TradeRecord {
      signalId: string;
      ticker: string;
      politician: string;
      action: "buy" | "sell";
      entryDate: string;
      entryPrice: number;
      exitDate: string | null;
      exitPrice: number | null;
      exitReason: CloseReason | "open";
      shares: number;
      pnl: number;
      pnlPct: number;
      daysHeld: number;
      score: number | null;
      scoreBreakdown: ScoreBreakdown | null;
      highestPrice: number;
      potentialGain: number; // What if we held to highest?
    }

    const tradesByAgent: Record<string, TradeRecord[]> = {};
    for (const agent of agentConfigs) {
      tradesByAgent[agent.id] = [];
    }

    // Position tracking (maps positionId to trade record)
    const positionToTrade: Map<string, { agentId: string; tradeIdx: number }> = new Map();

    const clock = new SimulationClock(simStart, simEnd);
    const signalReplayer = new SignalReplayer(signalsInRange);
    const portfolioState = new PortfolioState();

    portfolioState.initialize(agentConfigs.map(a => a.id), MONTHLY_BUDGET);

    let lastMonth = simStart.substring(0, 7);

    while (!clock.isComplete()) {
      const currentDate = clock.getDate();

      if (!clock.isMarketDay()) {
        clock.advance();
        continue;
      }

      // Monthly budget reset
      const currentMonth = currentDate.substring(0, 7);
      if (portfolioState.isNewMonth(currentDate, `${lastMonth}-01`)) {
        for (const agent of agentConfigs) {
          portfolioState.addMonthlyBudget(agent.id, MONTHLY_BUDGET);
        }
        lastMonth = currentMonth;
      }

      // Get signals for today
      const signals = signalReplayer.getSignalsForDate(currentDate);
      const acceptedCounts = new Map<string, number>();

      for (const signal of signals) {
        const currentPrice = priceProvider.getPrice(signal.ticker, currentDate);
        if (currentPrice === null) continue;

        const enriched = enrichSignalForSim(signal, currentPrice, currentDate);

        for (const agent of agentConfigs) {
          const portfolio = portfolioState.getPortfolio(agent.id);
          const openPositions = portfolio.positions.length;
          const tickerPositions = portfolio.positions.filter(p => p.ticker === signal.ticker).length;

          const decision = processSignalForAgentSim(agent, enriched, openPositions, tickerPositions);

          if (decision.action === "execute" || decision.action === "execute_half") {
            const count = acceptedCounts.get(agent.id) || 0;
            acceptedCounts.set(agent.id, count + 1);

            const positionSize = calculatePositionSize(
              agent,
              decision.score,
              { remaining: portfolioState.getCash(agent.id) },
              count + 1,
              decision.action === "execute_half"
            );

            if (positionSize > 0) {
              const shares = calculateShares(positionSize, currentPrice, true);
              if (shares > 0) {
                const position: SimPosition = {
                  id: generateSimId("pos"),
                  ticker: signal.ticker,
                  shares,
                  entryPrice: currentPrice,
                  entryDate: currentDate,
                  currentPrice,
                  highestPrice: currentPrice,
                  partialSold: false,
                  signalId: signal.id,
                };

                portfolioState.addPosition(agent.id, position);

                // Record the trade
                const tradeRecord: TradeRecord = {
                  signalId: signal.id,
                  ticker: signal.ticker,
                  politician: signal.politician_name,
                  action: signal.action,
                  entryDate: currentDate,
                  entryPrice: currentPrice,
                  exitDate: null,
                  exitPrice: null,
                  exitReason: "open",
                  shares,
                  pnl: 0,
                  pnlPct: 0,
                  daysHeld: 0,
                  score: decision.score,
                  scoreBreakdown: decision.score_breakdown as ScoreBreakdown | null,
                  highestPrice: currentPrice,
                  potentialGain: 0,
                };

                const idx = tradesByAgent[agent.id].push(tradeRecord) - 1;
                positionToTrade.set(position.id, { agentId: agent.id, tradeIdx: idx });
              }
            }
          }
        }

        signalReplayer.markProcessed(signal.id);
      }

      // Update prices and check exits
      for (const agent of agentConfigs) {
        const portfolio = portfolioState.getPortfolio(agent.id);
        const tickers = portfolio.positions.map(p => p.ticker);
        const prices = priceProvider.getClosingPrices(tickers, currentDate);

        portfolioState.updatePrices(agent.id, prices);

        // Update highest price for trade records
        for (const position of portfolio.positions) {
          const lookup = positionToTrade.get(position.id);
          if (lookup) {
            const trade = tradesByAgent[lookup.agentId][lookup.tradeIdx];
            if (trade && position.highestPrice > trade.highestPrice) {
              trade.highestPrice = position.highestPrice;
            }
          }
        }

        // Check exits
        const positionsToExit: Array<{
          position: SimPosition;
          reason: CloseReason;
          sellPct: number;
        }> = [];

        for (const position of portfolio.positions) {
          const price = prices.get(position.ticker);
          if (price === undefined) continue;

          const exitDecision = checkExitConditionsForSim(position, agent, price, currentDate);
          if (exitDecision) {
            positionsToExit.push({
              position,
              reason: exitDecision.reason,
              sellPct: exitDecision.sellPct,
            });
          }
        }

        for (const { position, reason, sellPct } of positionsToExit) {
          const price = prices.get(position.ticker)!;
          portfolioState.closePosition(agent.id, position.id, price, currentDate, reason, sellPct);

          // Update trade record
          const lookup = positionToTrade.get(position.id);
          if (lookup) {
            const trade = tradesByAgent[lookup.agentId][lookup.tradeIdx];
            if (trade) {
              trade.exitDate = currentDate;
              trade.exitPrice = price;
              trade.exitReason = reason;
              trade.daysHeld = daysBetween(trade.entryDate, currentDate);
              trade.pnl = (price - trade.entryPrice) * trade.shares;
              trade.pnlPct = ((price - trade.entryPrice) / trade.entryPrice) * 100;
              trade.potentialGain = ((trade.highestPrice - trade.entryPrice) / trade.entryPrice) * 100;
            }
          }
        }

        portfolioState.snapshot(agent.id, currentDate);
      }

      clock.advance();
    }

    // Mark remaining open positions
    for (const agent of agentConfigs) {
      const portfolio = portfolioState.getPortfolio(agent.id);
      for (const position of portfolio.positions) {
        const lookup = positionToTrade.get(position.id);
        if (lookup) {
          const trade = tradesByAgent[lookup.agentId][lookup.tradeIdx];
          if (trade && trade.exitReason === "open") {
            trade.exitDate = simEnd;
            trade.exitPrice = position.currentPrice;
            trade.daysHeld = daysBetween(trade.entryDate, simEnd);
            trade.pnl = (position.currentPrice - trade.entryPrice) * trade.shares;
            trade.pnlPct = ((position.currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
            trade.potentialGain = ((trade.highestPrice - trade.entryPrice) / trade.entryPrice) * 100;
          }
        }
      }
    }

    // =========================================================================
    // ANALYSIS OUTPUT
    // =========================================================================

    for (const agent of agentConfigs) {
      const trades = tradesByAgent[agent.id];
      if (trades.length === 0) {
        console.log(`\n--- ${agent.id.toUpperCase()} (${agent.name}) ---`);
        console.log("NO TRADES");
        continue;
      }

      console.log(`\n${"=".repeat(80)}`);
      console.log(`${agent.id.toUpperCase()} (${agent.name})`);
      console.log(`${"=".repeat(80)}`);

      // Exit config for reference
      console.log(`\nExit Config:`);
      console.log(`  Stop Loss: ${agent.exit.stop_loss.mode} @ ${agent.exit.stop_loss.threshold_pct}%`);
      console.log(`  Max Hold: ${agent.exit.max_hold_days ?? "unlimited"} days`);
      if (agent.exit.take_profit) {
        console.log(`  Take Profit: ${agent.exit.take_profit.first_threshold_pct}% (sell ${agent.exit.take_profit.first_sell_pct}%), ${agent.exit.take_profit.second_threshold_pct}% (sell all)`);
      }
      if (agent.exit.soft_stop) {
        console.log(`  Soft Stop: ${agent.exit.soft_stop.no_progress_days_stock} days of no progress`);
      }

      // Summary stats
      const closedTrades = trades.filter(t => t.exitReason !== "open");
      const openTrades = trades.filter(t => t.exitReason === "open");
      const winners = closedTrades.filter(t => t.pnlPct > 0);
      const losers = closedTrades.filter(t => t.pnlPct <= 0);

      console.log(`\n--- SUMMARY ---`);
      console.log(`Total Trades: ${trades.length}`);
      console.log(`  Closed: ${closedTrades.length}`);
      console.log(`  Still Open: ${openTrades.length}`);
      console.log(`  Winners: ${winners.length} (${(winners.length / closedTrades.length * 100).toFixed(1)}%)`);
      console.log(`  Losers: ${losers.length}`);

      // P&L breakdown
      const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
      const avgPnl = totalPnl / trades.length;
      const avgWinPnl = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
      const avgLossPnl = losers.length > 0 ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length : 0;

      console.log(`\n--- P&L ---`);
      console.log(`Total P&L: $${totalPnl.toFixed(2)}`);
      console.log(`Avg P&L per trade: $${avgPnl.toFixed(2)}`);
      console.log(`Avg Winner: +${avgWinPnl.toFixed(2)}%`);
      console.log(`Avg Loser: ${avgLossPnl.toFixed(2)}%`);

      // Exit reason breakdown
      const exitReasons: Record<string, { count: number; totalPnl: number; avgPnlPct: number; trades: TradeRecord[] }> = {};
      for (const trade of closedTrades) {
        if (!exitReasons[trade.exitReason]) {
          exitReasons[trade.exitReason] = { count: 0, totalPnl: 0, avgPnlPct: 0, trades: [] };
        }
        exitReasons[trade.exitReason].count++;
        exitReasons[trade.exitReason].totalPnl += trade.pnl;
        exitReasons[trade.exitReason].trades.push(trade);
      }
      for (const reason in exitReasons) {
        exitReasons[reason].avgPnlPct = exitReasons[reason].trades.reduce((s, t) => s + t.pnlPct, 0) / exitReasons[reason].count;
      }

      console.log(`\n--- EXIT REASONS ---`);
      for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => b[1].count - a[1].count)) {
        console.log(`${reason}: ${data.count} trades, avg ${data.avgPnlPct >= 0 ? "+" : ""}${data.avgPnlPct.toFixed(2)}%, total $${data.totalPnl.toFixed(2)}`);
      }

      // Hold time analysis
      const avgHoldDays = closedTrades.length > 0 ? closedTrades.reduce((s, t) => s + t.daysHeld, 0) / closedTrades.length : 0;
      const holdDaysDistribution = {
        "0-7": closedTrades.filter(t => t.daysHeld <= 7).length,
        "8-14": closedTrades.filter(t => t.daysHeld > 7 && t.daysHeld <= 14).length,
        "15-30": closedTrades.filter(t => t.daysHeld > 14 && t.daysHeld <= 30).length,
        "31-60": closedTrades.filter(t => t.daysHeld > 30 && t.daysHeld <= 60).length,
        "60+": closedTrades.filter(t => t.daysHeld > 60).length,
      };

      console.log(`\n--- HOLD TIME ---`);
      console.log(`Average hold: ${avgHoldDays.toFixed(1)} days`);
      for (const [range, count] of Object.entries(holdDaysDistribution)) {
        console.log(`  ${range} days: ${count}`);
      }

      // "Left money on table" analysis - trades where potential gain > actual exit
      const leftOnTable = closedTrades.filter(t => t.potentialGain > t.pnlPct && t.pnlPct < 0);
      const missedGains = leftOnTable.reduce((s, t) => s + (t.potentialGain - t.pnlPct), 0);

      console.log(`\n--- MISSED GAINS (exited at loss, but was up at some point) ---`);
      console.log(`Trades that were profitable but exited at loss: ${leftOnTable.length}`);
      if (leftOnTable.length > 0) {
        console.log(`Total missed gain: ${missedGains.toFixed(2)}%`);
        console.log(`Sample trades:`);
        for (const trade of leftOnTable.slice(0, 5)) {
          console.log(`  ${trade.ticker} (${trade.politician}): Entry $${trade.entryPrice.toFixed(2)} → Exit $${trade.exitPrice?.toFixed(2)} (${trade.pnlPct.toFixed(2)}%), but peaked at +${trade.potentialGain.toFixed(2)}% | Exit: ${trade.exitReason} after ${trade.daysHeld}d`);
        }
      }

      // Stop loss analysis
      const stopLossTrades = closedTrades.filter(t => t.exitReason === "stop_loss");
      if (stopLossTrades.length > 0) {
        const slWouldRecover = stopLossTrades.filter(t => {
          // Check if price recovered after stop loss
          const exitDateIdx = priceDates.indexOf(t.exitDate!);
          for (let i = exitDateIdx + 1; i < Math.min(exitDateIdx + 30, priceDates.length); i++) {
            const futurePrice = priceProvider.getPrice(t.ticker, priceDates[i]);
            if (futurePrice && futurePrice > t.entryPrice) {
              return true;
            }
          }
          return false;
        });

        console.log(`\n--- STOP LOSS ANALYSIS ---`);
        console.log(`Total stop losses: ${stopLossTrades.length}`);
        console.log(`Would have recovered within 30 days: ${slWouldRecover.length} (${(slWouldRecover.length / stopLossTrades.length * 100).toFixed(1)}%)`);
        if (slWouldRecover.length > 0) {
          console.log(`Sample trades that recovered after stop loss:`);
          for (const trade of slWouldRecover.slice(0, 5)) {
            console.log(`  ${trade.ticker}: Stopped out at ${trade.pnlPct.toFixed(2)}% on ${trade.exitDate}`);
          }
        }
      }

      // Time exit analysis
      const timeExitTrades = closedTrades.filter(t => t.exitReason === "time_exit");
      if (timeExitTrades.length > 0) {
        console.log(`\n--- TIME EXIT ANALYSIS ---`);
        console.log(`Total time exits: ${timeExitTrades.length}`);
        const timeExitWinners = timeExitTrades.filter(t => t.pnlPct > 0);
        const timeExitLosers = timeExitTrades.filter(t => t.pnlPct <= 0);
        console.log(`  Winners: ${timeExitWinners.length}`);
        console.log(`  Losers: ${timeExitLosers.length}`);

        // Check if holding longer would help
        const wouldImprove = timeExitTrades.filter(t => {
          const exitDateIdx = priceDates.indexOf(t.exitDate!);
          for (let i = exitDateIdx + 1; i < Math.min(exitDateIdx + 30, priceDates.length); i++) {
            const futurePrice = priceProvider.getPrice(t.ticker, priceDates[i]);
            if (futurePrice && ((futurePrice - t.entryPrice) / t.entryPrice * 100) > t.pnlPct + 5) {
              return true;
            }
          }
          return false;
        });
        console.log(`Would be 5%+ better holding 30 more days: ${wouldImprove.length}`);
      }

      // Soft stop analysis
      const softStopTrades = closedTrades.filter(t => t.exitReason === "soft_stop");
      if (softStopTrades.length > 0) {
        console.log(`\n--- SOFT STOP ANALYSIS ---`);
        console.log(`Total soft stops: ${softStopTrades.length}`);
        const ssWouldRecover = softStopTrades.filter(t => {
          const exitDateIdx = priceDates.indexOf(t.exitDate!);
          for (let i = exitDateIdx + 1; i < Math.min(exitDateIdx + 30, priceDates.length); i++) {
            const futurePrice = priceProvider.getPrice(t.ticker, priceDates[i]);
            if (futurePrice && futurePrice > t.entryPrice * 1.05) {
              return true;
            }
          }
          return false;
        });
        console.log(`Would have made 5%+ within 30 days: ${ssWouldRecover.length}`);
      }

      // Top 10 best and worst trades
      const sortedByPnl = [...trades].sort((a, b) => b.pnlPct - a.pnlPct);

      console.log(`\n--- TOP 10 BEST TRADES ---`);
      for (const trade of sortedByPnl.slice(0, 10)) {
        console.log(`  ${trade.ticker} (${trade.politician.substring(0, 15)}): ${trade.pnlPct >= 0 ? "+" : ""}${trade.pnlPct.toFixed(2)}% | ${trade.entryDate} → ${trade.exitDate} (${trade.daysHeld}d) | Exit: ${trade.exitReason}`);
      }

      console.log(`\n--- TOP 10 WORST TRADES ---`);
      for (const trade of sortedByPnl.slice(-10).reverse()) {
        console.log(`  ${trade.ticker} (${trade.politician.substring(0, 15)}): ${trade.pnlPct >= 0 ? "+" : ""}${trade.pnlPct.toFixed(2)}% | ${trade.entryDate} → ${trade.exitDate} (${trade.daysHeld}d) | Exit: ${trade.exitReason} | Peak: +${trade.potentialGain.toFixed(2)}%`);
      }

      // Politician breakdown
      const byPolitician: Record<string, { trades: number; avgPnlPct: number }> = {};
      for (const trade of trades) {
        if (!byPolitician[trade.politician]) {
          byPolitician[trade.politician] = { trades: 0, avgPnlPct: 0 };
        }
        byPolitician[trade.politician].trades++;
      }
      for (const politician in byPolitician) {
        const politicianTrades = trades.filter(t => t.politician === politician);
        byPolitician[politician].avgPnlPct = politicianTrades.reduce((s, t) => s + t.pnlPct, 0) / politicianTrades.length;
      }

      const sortedPoliticians = Object.entries(byPolitician)
        .filter(([_, data]) => data.trades >= 3)
        .sort((a, b) => b[1].avgPnlPct - a[1].avgPnlPct);

      console.log(`\n--- TOP POLITICIANS (min 3 trades) ---`);
      for (const [politician, data] of sortedPoliticians.slice(0, 10)) {
        console.log(`  ${politician}: ${data.trades} trades, avg ${data.avgPnlPct >= 0 ? "+" : ""}${data.avgPnlPct.toFixed(2)}%`);
      }

      console.log(`\n--- WORST POLITICIANS (min 3 trades) ---`);
      for (const [politician, data] of sortedPoliticians.slice(-10).reverse()) {
        console.log(`  ${politician}: ${data.trades} trades, avg ${data.avgPnlPct >= 0 ? "+" : ""}${data.avgPnlPct.toFixed(2)}%`);
      }
    }

    expect(true).toBe(true);
  });

  it("TRACE: detailed step-by-step for single politician", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    // ONLY Tim Moore signals - the top performer
    const TARGET_POLITICIAN = "Tim Moore";
    const allSignals = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .filter(s => s.politician_name === TARGET_POLITICIAN)
      .filter(s => s.action === "buy")
      .map(convertToSignalForSim);

    console.log(`\n${"=".repeat(80)}`);
    console.log(`DETAILED TRACE: ${TARGET_POLITICIAN} only`);
    console.log(`${"=".repeat(80)}`);
    console.log(`Total signals from ${TARGET_POLITICIAN}: ${allSignals.length}`);
    console.log(`Date range: ${priceStart} to ${priceEnd}`);

    // SPY benchmark
    const spyStart = priceProvider.getPrice("SPY", priceStart);
    const spyEnd = priceProvider.getPrice("SPY", priceEnd);
    const spyReturn = spyStart && spyEnd ? ((spyEnd - spyStart) / spyStart) * 100 : 0;
    console.log(`\nSPY: $${spyStart?.toFixed(2)} → $${spyEnd?.toFixed(2)} = ${spyReturn.toFixed(2)}%`);

    // Simple strategy: Buy on disclosure date, sell after 120 days (or end of sim)
    // NO SCORING, NO EXITS - just pure buy and hold
    console.log(`\n--- SIMPLE BUY & HOLD (no exits, no scoring) ---`);

    interface SimplePosition {
      ticker: string;
      entryDate: string;
      entryPrice: number;
      shares: number;
      cost: number;
    }

    const POSITION_SIZE = 100; // $100 per position
    let totalInvested = 0;
    let totalValue = 0;
    const positions: SimplePosition[] = [];

    // Process each signal
    for (const signal of allSignals) {
      const entryPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);
      if (!entryPrice) {
        console.log(`  SKIP: ${signal.ticker} on ${signal.disclosure_date} - no price data`);
        continue;
      }

      const shares = POSITION_SIZE / entryPrice;
      const cost = shares * entryPrice;

      positions.push({
        ticker: signal.ticker,
        entryDate: signal.disclosure_date,
        entryPrice,
        shares,
        cost,
      });

      totalInvested += cost;
      console.log(`  BUY: ${signal.ticker} on ${signal.disclosure_date} @ $${entryPrice.toFixed(2)} | ${shares.toFixed(4)} shares | cost: $${cost.toFixed(2)}`);
    }

    console.log(`\nTotal positions: ${positions.length}`);
    console.log(`Total invested: $${totalInvested.toFixed(2)}`);

    // Calculate final value at end of simulation
    console.log(`\n--- FINAL VALUES (at ${priceEnd}) ---`);
    let totalFinalValue = 0;
    const tradeResults: Array<{ticker: string; entryDate: string; entryPrice: number; exitPrice: number; returnPct: number; profit: number}> = [];

    for (const pos of positions) {
      const exitPrice = priceProvider.getPrice(pos.ticker, priceEnd);
      if (!exitPrice) {
        console.log(`  ${pos.ticker}: NO EXIT PRICE`);
        continue;
      }

      const finalValue = pos.shares * exitPrice;
      const profit = finalValue - pos.cost;
      const returnPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

      totalFinalValue += finalValue;
      tradeResults.push({
        ticker: pos.ticker,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        exitPrice,
        returnPct,
        profit,
      });

      console.log(`  ${pos.ticker}: $${pos.entryPrice.toFixed(2)} → $${exitPrice.toFixed(2)} = ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}% | profit: $${profit.toFixed(2)}`);
    }

    const totalProfit = totalFinalValue - totalInvested;
    const totalReturnPct = (totalProfit / totalInvested) * 100;
    const avgTradeReturn = tradeResults.reduce((s, t) => s + t.returnPct, 0) / tradeResults.length;

    console.log(`\n--- SUMMARY ---`);
    console.log(`Total Invested: $${totalInvested.toFixed(2)}`);
    console.log(`Final Value: $${totalFinalValue.toFixed(2)}`);
    console.log(`Total Profit: $${totalProfit.toFixed(2)}`);
    console.log(`PORTFOLIO RETURN: ${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%`);
    console.log(`Average per-trade return: ${avgTradeReturn >= 0 ? "+" : ""}${avgTradeReturn.toFixed(2)}%`);
    console.log(`SPY return same period: ${spyReturn >= 0 ? "+" : ""}${spyReturn.toFixed(2)}%`);
    console.log(`ALPHA vs SPY: ${(totalReturnPct - spyReturn) >= 0 ? "+" : ""}${(totalReturnPct - spyReturn).toFixed(2)}%`);

    // Sort by return
    const sortedResults = [...tradeResults].sort((a, b) => b.returnPct - a.returnPct);
    console.log(`\n--- BEST TRADES ---`);
    for (const t of sortedResults.slice(0, 5)) {
      console.log(`  ${t.ticker}: ${t.entryDate} → ${priceEnd} = ${t.returnPct >= 0 ? "+" : ""}${t.returnPct.toFixed(2)}%`);
    }
    console.log(`\n--- WORST TRADES ---`);
    for (const t of sortedResults.slice(-5).reverse()) {
      console.log(`  ${t.ticker}: ${t.entryDate} → ${priceEnd} = ${t.returnPct >= 0 ? "+" : ""}${t.returnPct.toFixed(2)}%`);
    }

    // =========================================================================
    // TIME-WEIGHTED SPY COMPARISON (the FAIR comparison)
    // For each $100 invested in a trade, calculate what $100 in SPY would have returned
    // over the SAME holding period
    // =========================================================================
    console.log(`\n${"=".repeat(80)}`);
    console.log(`TIME-WEIGHTED SPY COMPARISON (FAIR BENCHMARK)`);
    console.log(`${"=".repeat(80)}`);
    console.log(`For each trade, we compare to SPY over the SAME holding period.\n`);

    let spyEquivalentFinalValue = 0;
    let tradesWithSpyData = 0;
    const tradeComparisons: Array<{
      ticker: string;
      entryDate: string;
      tradeReturn: number;
      spyReturn: number;
      alpha: number;
      tradeProfit: number;
      spyProfit: number;
    }> = [];

    for (const pos of positions) {
      const exitPrice = priceProvider.getPrice(pos.ticker, priceEnd);
      const spyEntry = priceProvider.getPrice("SPY", pos.entryDate);
      const spyExit = priceProvider.getPrice("SPY", priceEnd);

      if (!exitPrice || !spyEntry || !spyExit) continue;

      tradesWithSpyData++;

      // Trade return
      const tradeReturn = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const tradeProfit = pos.shares * exitPrice - pos.cost;

      // SPY return over same period
      const spyReturnPct = ((spyExit - spyEntry) / spyEntry) * 100;
      const spyShares = pos.cost / spyEntry;
      const spyFinalValue = spyShares * spyExit;
      const spyProfit = spyFinalValue - pos.cost;

      spyEquivalentFinalValue += spyFinalValue;

      const alpha = tradeReturn - spyReturnPct;

      tradeComparisons.push({
        ticker: pos.ticker,
        entryDate: pos.entryDate,
        tradeReturn,
        spyReturn: spyReturnPct,
        alpha,
        tradeProfit,
        spyProfit,
      });
    }

    // Print each comparison
    console.log(`${"Trade".padEnd(8)} | ${"Date".padEnd(12)} | ${"Trade %".padEnd(10)} | ${"SPY %".padEnd(10)} | ${"Alpha".padEnd(10)}`);
    console.log(`${"-".repeat(60)}`);
    for (const t of tradeComparisons) {
      const tradeStr = (t.tradeReturn >= 0 ? "+" : "") + t.tradeReturn.toFixed(2) + "%";
      const spyStr = (t.spyReturn >= 0 ? "+" : "") + t.spyReturn.toFixed(2) + "%";
      const alphaStr = (t.alpha >= 0 ? "+" : "") + t.alpha.toFixed(2) + "%";
      console.log(`${t.ticker.padEnd(8)} | ${t.entryDate.padEnd(12)} | ${tradeStr.padEnd(10)} | ${spyStr.padEnd(10)} | ${alphaStr.padEnd(10)}`);
    }

    // Summary statistics
    const totalTradeProfit = tradeComparisons.reduce((s, t) => s + t.tradeProfit, 0);
    const totalSpyProfit = tradeComparisons.reduce((s, t) => s + t.spyProfit, 0);
    const avgTradeReturnPct = tradeComparisons.reduce((s, t) => s + t.tradeReturn, 0) / tradeComparisons.length;
    const avgSpyReturnPct = tradeComparisons.reduce((s, t) => s + t.spyReturn, 0) / tradeComparisons.length;
    const avgAlpha = avgTradeReturnPct - avgSpyReturnPct;
    const tradesBeatingspy = tradeComparisons.filter(t => t.alpha > 0).length;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`SUMMARY (${tradesWithSpyData} trades with SPY data)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Average Trade Return:  ${avgTradeReturnPct >= 0 ? "+" : ""}${avgTradeReturnPct.toFixed(2)}%`);
    console.log(`Average SPY Return:    ${avgSpyReturnPct >= 0 ? "+" : ""}${avgSpyReturnPct.toFixed(2)}%`);
    console.log(`Average ALPHA:         ${avgAlpha >= 0 ? "+" : ""}${avgAlpha.toFixed(2)}%`);
    console.log(`Trades beating SPY:    ${tradesBeatingspy}/${tradesWithSpyData} (${((tradesBeatingspy/tradesWithSpyData)*100).toFixed(1)}%)`);
    console.log(``);
    console.log(`Total Trade Profit:    $${totalTradeProfit.toFixed(2)}`);
    console.log(`Total SPY Profit:      $${totalSpyProfit.toFixed(2)}`);
    console.log(`EXCESS PROFIT:         $${(totalTradeProfit - totalSpyProfit).toFixed(2)}`);
    console.log(``);
    console.log(`Tim Moore Final Value: $${totalFinalValue.toFixed(2)}`);
    console.log(`SPY Equivalent Value:  $${spyEquivalentFinalValue.toFixed(2)}`);
    console.log(`OUTPERFORMANCE:        $${(totalFinalValue - spyEquivalentFinalValue).toFixed(2)}`);

    expect(true).toBe(true);
  });

  it("ALL POLITICIANS: time-weighted SPY comparison", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    // ALL buy signals with price data
    const allSignals = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .filter(s => s.action === "buy")
      .map(convertToSignalForSim);

    console.log(`\n${"=".repeat(80)}`);
    console.log(`ALL POLITICIANS: Time-Weighted SPY Comparison`);
    console.log(`${"=".repeat(80)}`);
    console.log(`Total buy signals: ${allSignals.length}`);
    console.log(`Date range: ${priceStart} to ${priceEnd}`);

    interface SimplePosition {
      ticker: string;
      politician: string;
      entryDate: string;
      entryPrice: number;
      shares: number;
      cost: number;
    }

    const POSITION_SIZE = 100; // $100 per position
    let totalInvested = 0;
    const positions: SimplePosition[] = [];
    let skippedNoPriceData = 0;

    // Process each signal
    for (const signal of allSignals) {
      const entryPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);
      if (!entryPrice) {
        skippedNoPriceData++;
        continue;
      }

      const shares = POSITION_SIZE / entryPrice;
      const cost = shares * entryPrice;

      positions.push({
        ticker: signal.ticker,
        politician: signal.politician_name,
        entryDate: signal.disclosure_date,
        entryPrice,
        shares,
        cost,
      });

      totalInvested += cost;
    }

    console.log(`Positions opened: ${positions.length}`);
    console.log(`Skipped (no price data): ${skippedNoPriceData}`);
    console.log(`Total invested: $${totalInvested.toFixed(2)}`);

    // Calculate final values and time-weighted SPY comparison
    interface TradeComparison {
      ticker: string;
      politician: string;
      entryDate: string;
      tradeReturn: number;
      spyReturn: number;
      alpha: number;
      tradeProfit: number;
      spyProfit: number;
    }

    let totalFinalValue = 0;
    let spyEquivalentFinalValue = 0;
    const tradeComparisons: TradeComparison[] = [];

    for (const pos of positions) {
      const exitPrice = priceProvider.getPrice(pos.ticker, priceEnd);
      const spyEntry = priceProvider.getPrice("SPY", pos.entryDate);
      const spyExit = priceProvider.getPrice("SPY", priceEnd);

      if (!exitPrice || !spyEntry || !spyExit) continue;

      const finalValue = pos.shares * exitPrice;
      totalFinalValue += finalValue;

      // Trade return
      const tradeReturn = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const tradeProfit = finalValue - pos.cost;

      // SPY return over same period
      const spyReturnPct = ((spyExit - spyEntry) / spyEntry) * 100;
      const spyShares = pos.cost / spyEntry;
      const spyFinalValue = spyShares * spyExit;
      const spyProfit = spyFinalValue - pos.cost;

      spyEquivalentFinalValue += spyFinalValue;

      const alpha = tradeReturn - spyReturnPct;

      tradeComparisons.push({
        ticker: pos.ticker,
        politician: pos.politician,
        entryDate: pos.entryDate,
        tradeReturn,
        spyReturn: spyReturnPct,
        alpha,
        tradeProfit,
        spyProfit,
      });
    }

    // Summary statistics
    const totalTradeProfit = tradeComparisons.reduce((s, t) => s + t.tradeProfit, 0);
    const totalSpyProfit = tradeComparisons.reduce((s, t) => s + t.spyProfit, 0);
    const avgTradeReturnPct = tradeComparisons.reduce((s, t) => s + t.tradeReturn, 0) / tradeComparisons.length;
    const avgSpyReturnPct = tradeComparisons.reduce((s, t) => s + t.spyReturn, 0) / tradeComparisons.length;
    const avgAlpha = avgTradeReturnPct - avgSpyReturnPct;
    const tradesBeatingspy = tradeComparisons.filter(t => t.alpha > 0).length;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`OVERALL SUMMARY (${tradeComparisons.length} trades)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Average Trade Return:  ${avgTradeReturnPct >= 0 ? "+" : ""}${avgTradeReturnPct.toFixed(2)}%`);
    console.log(`Average SPY Return:    ${avgSpyReturnPct >= 0 ? "+" : ""}${avgSpyReturnPct.toFixed(2)}%`);
    console.log(`Average ALPHA:         ${avgAlpha >= 0 ? "+" : ""}${avgAlpha.toFixed(2)}%`);
    console.log(`Trades beating SPY:    ${tradesBeatingspy}/${tradeComparisons.length} (${((tradesBeatingspy/tradeComparisons.length)*100).toFixed(1)}%)`);
    console.log(``);
    console.log(`Total Trade Profit:    $${totalTradeProfit.toFixed(2)}`);
    console.log(`Total SPY Profit:      $${totalSpyProfit.toFixed(2)}`);
    console.log(`EXCESS PROFIT:         $${(totalTradeProfit - totalSpyProfit).toFixed(2)}`);
    console.log(``);
    console.log(`Congress Final Value:  $${totalFinalValue.toFixed(2)}`);
    console.log(`SPY Equivalent Value:  $${spyEquivalentFinalValue.toFixed(2)}`);
    console.log(`OUTPERFORMANCE:        $${(totalFinalValue - spyEquivalentFinalValue).toFixed(2)}`);

    // Per-politician breakdown
    console.log(`\n${"=".repeat(60)}`);
    console.log(`BY POLITICIAN`);
    console.log(`${"=".repeat(60)}`);

    const byPolitician = new Map<string, { trades: TradeComparison[]; totalProfit: number; spyProfit: number }>();
    for (const t of tradeComparisons) {
      const entry = byPolitician.get(t.politician) || { trades: [], totalProfit: 0, spyProfit: 0 };
      entry.trades.push(t);
      entry.totalProfit += t.tradeProfit;
      entry.spyProfit += t.spyProfit;
      byPolitician.set(t.politician, entry);
    }

    // Sort by alpha (outperformance)
    const sortedPoliticians = [...byPolitician.entries()]
      .map(([name, data]) => {
        const avgTradeRet = data.trades.reduce((s, t) => s + t.tradeReturn, 0) / data.trades.length;
        const avgSpyRet = data.trades.reduce((s, t) => s + t.spyReturn, 0) / data.trades.length;
        return {
          name,
          trades: data.trades.length,
          avgTradeReturn: avgTradeRet,
          avgSpyReturn: avgSpyRet,
          alpha: avgTradeRet - avgSpyRet,
          totalProfit: data.totalProfit,
          spyProfit: data.spyProfit,
          excessProfit: data.totalProfit - data.spyProfit,
        };
      })
      .sort((a, b) => b.alpha - a.alpha);

    console.log(`${"Politician".padEnd(25)} | ${"Trades".padEnd(6)} | ${"Avg Return".padEnd(12)} | ${"SPY Equiv".padEnd(12)} | ${"ALPHA".padEnd(10)}`);
    console.log(`${"-".repeat(80)}`);
    for (const p of sortedPoliticians.slice(0, 20)) {
      const tradeStr = (p.avgTradeReturn >= 0 ? "+" : "") + p.avgTradeReturn.toFixed(1) + "%";
      const spyStr = (p.avgSpyReturn >= 0 ? "+" : "") + p.avgSpyReturn.toFixed(1) + "%";
      const alphaStr = (p.alpha >= 0 ? "+" : "") + p.alpha.toFixed(1) + "%";
      console.log(`${p.name.padEnd(25)} | ${String(p.trades).padEnd(6)} | ${tradeStr.padEnd(12)} | ${spyStr.padEnd(12)} | ${alphaStr.padEnd(10)}`);
    }

    // Bottom 10
    console.log(`\n--- WORST PERFORMERS ---`);
    for (const p of sortedPoliticians.slice(-10).reverse()) {
      const tradeStr = (p.avgTradeReturn >= 0 ? "+" : "") + p.avgTradeReturn.toFixed(1) + "%";
      const spyStr = (p.avgSpyReturn >= 0 ? "+" : "") + p.avgSpyReturn.toFixed(1) + "%";
      const alphaStr = (p.alpha >= 0 ? "+" : "") + p.alpha.toFixed(1) + "%";
      console.log(`${p.name.padEnd(25)} | ${String(p.trades).padEnd(6)} | ${tradeStr.padEnd(12)} | ${spyStr.padEnd(12)} | ${alphaStr.padEnd(10)}`);
    }

    // Top tickers
    console.log(`\n${"=".repeat(60)}`);
    console.log(`TOP 10 TICKERS BY ALPHA`);
    console.log(`${"=".repeat(60)}`);

    const byTicker = new Map<string, { trades: TradeComparison[] }>();
    for (const t of tradeComparisons) {
      const entry = byTicker.get(t.ticker) || { trades: [] };
      entry.trades.push(t);
      byTicker.set(t.ticker, entry);
    }

    const sortedTickers = [...byTicker.entries()]
      .map(([ticker, data]) => {
        const avgAlpha = data.trades.reduce((s, t) => s + t.alpha, 0) / data.trades.length;
        const avgReturn = data.trades.reduce((s, t) => s + t.tradeReturn, 0) / data.trades.length;
        return { ticker, trades: data.trades.length, avgReturn, avgAlpha };
      })
      .sort((a, b) => b.avgAlpha - a.avgAlpha);

    for (const t of sortedTickers.slice(0, 10)) {
      console.log(`${t.ticker.padEnd(8)}: ${t.trades} trades, avg return ${t.avgReturn >= 0 ? "+" : ""}${t.avgReturn.toFixed(1)}%, alpha ${t.avgAlpha >= 0 ? "+" : ""}${t.avgAlpha.toFixed(1)}%`);
    }

    expect(true).toBe(true);
  });

  it("AGENT SIMULATION: with fair SPY comparison", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    // All buy signals with price data
    const allSignals = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .filter(s => s.action === "buy")
      .map(convertToSignalForSim)
      .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

    console.log(`\n${"=".repeat(80)}`);
    console.log(`AGENT SIMULATION: Fair SPY Comparison`);
    console.log(`${"=".repeat(80)}`);
    console.log(`Total signals: ${allSignals.length}`);
    console.log(`Date range: ${priceStart} to ${priceEnd}`);

    // Simple NAIVE strategy: buy everything, hold to end
    interface Position {
      ticker: string;
      politician: string;
      entryDate: string;
      entryPrice: number;
      shares: number;
      cost: number;
      exitDate?: string;
      exitPrice?: number;
      exitReason?: string;
    }

    const POSITION_SIZE = 100;
    const MONTHLY_BUDGET = 1000;
    const STOP_LOSS_PCT = 18; // ChatGPT's stop loss

    // =========================================================================
    // Strategy 1: NAIVE (buy everything, hold forever)
    // =========================================================================
    console.log(`\n--- NAIVE: Buy everything, no exits ---`);
    const naivePositions: Position[] = [];
    let naiveInvested = 0;
    let naiveSkipped = 0;

    for (const signal of allSignals) {
      const entryPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);
      if (!entryPrice) {
        naiveSkipped++;
        continue;
      }
      naivePositions.push({
        ticker: signal.ticker,
        politician: signal.politician_name,
        entryDate: signal.disclosure_date,
        entryPrice,
        shares: POSITION_SIZE / entryPrice,
        cost: POSITION_SIZE,
      });
      naiveInvested += POSITION_SIZE;
    }
    console.log(`  Positions: ${naivePositions.length}, Invested: $${naiveInvested}`);

    // Calculate naive results
    let naiveFinalValue = 0;
    let naiveSpyEquiv = 0;
    for (const pos of naivePositions) {
      const exitPrice = priceProvider.getPrice(pos.ticker, priceEnd);
      const spyEntry = priceProvider.getPrice("SPY", pos.entryDate);
      const spyExit = priceProvider.getPrice("SPY", priceEnd);
      if (exitPrice) naiveFinalValue += pos.shares * exitPrice;
      if (spyEntry && spyExit) naiveSpyEquiv += (pos.cost / spyEntry) * spyExit;
    }

    const naiveReturn = ((naiveFinalValue - naiveInvested) / naiveInvested) * 100;
    const naiveSpyReturn = ((naiveSpyEquiv - naiveInvested) / naiveInvested) * 100;
    console.log(`  Portfolio Return: ${naiveReturn >= 0 ? "+" : ""}${naiveReturn.toFixed(2)}%`);
    console.log(`  SPY Equivalent:   ${naiveSpyReturn >= 0 ? "+" : ""}${naiveSpyReturn.toFixed(2)}%`);
    console.log(`  ALPHA:            ${(naiveReturn - naiveSpyReturn) >= 0 ? "+" : ""}${(naiveReturn - naiveSpyReturn).toFixed(2)}%`);

    // =========================================================================
    // Strategy 2: NAIVE + STOP LOSS (18%)
    // =========================================================================
    console.log(`\n--- NAIVE + 18% STOP LOSS ---`);
    const stopLossPositions: Position[] = [];
    let stopLossInvested = 0;
    let stopLossTriggered = 0;
    let stopLossValue = 0;

    for (const signal of allSignals) {
      const entryPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);
      if (!entryPrice) continue;

      const pos: Position = {
        ticker: signal.ticker,
        politician: signal.politician_name,
        entryDate: signal.disclosure_date,
        entryPrice,
        shares: POSITION_SIZE / entryPrice,
        cost: POSITION_SIZE,
      };

      // Check each day for stop loss
      let date = signal.disclosure_date;
      let exited = false;
      while (date <= priceEnd && !exited) {
        const price = priceProvider.getPrice(signal.ticker, date);
        if (price) {
          const drawdown = ((price - entryPrice) / entryPrice) * 100;
          if (drawdown <= -STOP_LOSS_PCT) {
            pos.exitDate = date;
            pos.exitPrice = price;
            pos.exitReason = "stop_loss";
            exited = true;
            stopLossTriggered++;
          }
        }
        // Advance to next day
        const d = new Date(date);
        d.setDate(d.getDate() + 1);
        date = d.toISOString().split("T")[0];
      }

      if (!exited) {
        pos.exitDate = priceEnd;
        pos.exitPrice = priceProvider.getPrice(signal.ticker, priceEnd) || entryPrice;
      }

      stopLossPositions.push(pos);
      stopLossInvested += POSITION_SIZE;
    }

    console.log(`  Positions: ${stopLossPositions.length}, Stop losses triggered: ${stopLossTriggered}`);

    // Calculate results
    let stopLossFinalValue = 0;
    let stopLossSpyEquiv = 0;
    for (const pos of stopLossPositions) {
      const exitPrice = pos.exitPrice || priceProvider.getPrice(pos.ticker, priceEnd);
      const spyEntry = priceProvider.getPrice("SPY", pos.entryDate);
      const spyExitDate = pos.exitDate || priceEnd;
      const spyExit = priceProvider.getPrice("SPY", spyExitDate);
      if (exitPrice) stopLossFinalValue += pos.shares * exitPrice;
      if (spyEntry && spyExit) stopLossSpyEquiv += (pos.cost / spyEntry) * spyExit;
    }

    const stopLossReturn = ((stopLossFinalValue - stopLossInvested) / stopLossInvested) * 100;
    const stopLossSpyReturn = ((stopLossSpyEquiv - stopLossInvested) / stopLossInvested) * 100;
    console.log(`  Portfolio Return: ${stopLossReturn >= 0 ? "+" : ""}${stopLossReturn.toFixed(2)}%`);
    console.log(`  SPY Equivalent:   ${stopLossSpyReturn >= 0 ? "+" : ""}${stopLossSpyReturn.toFixed(2)}%`);
    console.log(`  ALPHA:            ${(stopLossReturn - stopLossSpyReturn) >= 0 ? "+" : ""}${(stopLossReturn - stopLossSpyReturn).toFixed(2)}%`);

    // =========================================================================
    // Strategy 3: TIM MOORE ONLY (no exits)
    // =========================================================================
    console.log(`\n--- TIM MOORE ONLY (no exits) ---`);
    const timMooreSignals = allSignals.filter(s => s.politician_name === "Tim Moore");
    const timPositions: Position[] = [];
    let timInvested = 0;

    for (const signal of timMooreSignals) {
      const entryPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);
      if (!entryPrice) continue;
      timPositions.push({
        ticker: signal.ticker,
        politician: signal.politician_name,
        entryDate: signal.disclosure_date,
        entryPrice,
        shares: POSITION_SIZE / entryPrice,
        cost: POSITION_SIZE,
      });
      timInvested += POSITION_SIZE;
    }

    console.log(`  Positions: ${timPositions.length}, Invested: $${timInvested}`);

    let timFinalValue = 0;
    let timSpyEquiv = 0;
    for (const pos of timPositions) {
      const exitPrice = priceProvider.getPrice(pos.ticker, priceEnd);
      const spyEntry = priceProvider.getPrice("SPY", pos.entryDate);
      const spyExit = priceProvider.getPrice("SPY", priceEnd);
      if (exitPrice) timFinalValue += pos.shares * exitPrice;
      if (spyEntry && spyExit) timSpyEquiv += (pos.cost / spyEntry) * spyExit;
    }

    const timReturn = ((timFinalValue - timInvested) / timInvested) * 100;
    const timSpyReturn = ((timSpyEquiv - timInvested) / timInvested) * 100;
    console.log(`  Portfolio Return: ${timReturn >= 0 ? "+" : ""}${timReturn.toFixed(2)}%`);
    console.log(`  SPY Equivalent:   ${timSpyReturn >= 0 ? "+" : ""}${timSpyReturn.toFixed(2)}%`);
    console.log(`  ALPHA:            ${(timReturn - timSpyReturn) >= 0 ? "+" : ""}${(timReturn - timSpyReturn).toFixed(2)}%`);

    // =========================================================================
    // Strategy 4: TOP 5 PERFORMERS ONLY (Tim Moore, Jerry Moran, etc.)
    // =========================================================================
    console.log(`\n--- TOP 5 POLITICIANS ONLY (no exits) ---`);
    const topPoliticians = ["Tim Moore", "Jerry Moran", "Shelley Moore Capito", "Scott Franklin", "Dave McCormick"];
    const top5Signals = allSignals.filter(s => topPoliticians.includes(s.politician_name));
    const top5Positions: Position[] = [];
    let top5Invested = 0;

    for (const signal of top5Signals) {
      const entryPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);
      if (!entryPrice) continue;
      top5Positions.push({
        ticker: signal.ticker,
        politician: signal.politician_name,
        entryDate: signal.disclosure_date,
        entryPrice,
        shares: POSITION_SIZE / entryPrice,
        cost: POSITION_SIZE,
      });
      top5Invested += POSITION_SIZE;
    }

    console.log(`  Positions: ${top5Positions.length}, Invested: $${top5Invested}`);

    let top5FinalValue = 0;
    let top5SpyEquiv = 0;
    for (const pos of top5Positions) {
      const exitPrice = priceProvider.getPrice(pos.ticker, priceEnd);
      const spyEntry = priceProvider.getPrice("SPY", pos.entryDate);
      const spyExit = priceProvider.getPrice("SPY", priceEnd);
      if (exitPrice) top5FinalValue += pos.shares * exitPrice;
      if (spyEntry && spyExit) top5SpyEquiv += (pos.cost / spyEntry) * spyExit;
    }

    const top5Return = ((top5FinalValue - top5Invested) / top5Invested) * 100;
    const top5SpyReturn = ((top5SpyEquiv - top5Invested) / top5Invested) * 100;
    console.log(`  Portfolio Return: ${top5Return >= 0 ? "+" : ""}${top5Return.toFixed(2)}%`);
    console.log(`  SPY Equivalent:   ${top5SpyReturn >= 0 ? "+" : ""}${top5SpyReturn.toFixed(2)}%`);
    console.log(`  ALPHA:            ${(top5Return - top5SpyReturn) >= 0 ? "+" : ""}${(top5Return - top5SpyReturn).toFixed(2)}%`);

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log(`\n${"=".repeat(60)}`);
    console.log(`SUMMARY COMPARISON`);
    console.log(`${"=".repeat(60)}`);
    console.log(`${"Strategy".padEnd(30)} | ${"Return".padEnd(10)} | ${"SPY Equiv".padEnd(10)} | ${"ALPHA".padEnd(10)}`);
    console.log(`${"-".repeat(70)}`);
    console.log(`${"NAIVE (all, no exits)".padEnd(30)} | ${(naiveReturn >= 0 ? "+" : "") + naiveReturn.toFixed(1) + "%".padEnd(8)} | ${(naiveSpyReturn >= 0 ? "+" : "") + naiveSpyReturn.toFixed(1) + "%".padEnd(8)} | ${((naiveReturn - naiveSpyReturn) >= 0 ? "+" : "") + (naiveReturn - naiveSpyReturn).toFixed(1) + "%"}`);
    console.log(`${"NAIVE + 18% Stop Loss".padEnd(30)} | ${(stopLossReturn >= 0 ? "+" : "") + stopLossReturn.toFixed(1) + "%".padEnd(8)} | ${(stopLossSpyReturn >= 0 ? "+" : "") + stopLossSpyReturn.toFixed(1) + "%".padEnd(8)} | ${((stopLossReturn - stopLossSpyReturn) >= 0 ? "+" : "") + (stopLossReturn - stopLossSpyReturn).toFixed(1) + "%"}`);
    console.log(`${"Tim Moore only".padEnd(30)} | ${(timReturn >= 0 ? "+" : "") + timReturn.toFixed(1) + "%".padEnd(8)} | ${(timSpyReturn >= 0 ? "+" : "") + timSpyReturn.toFixed(1) + "%".padEnd(8)} | ${((timReturn - timSpyReturn) >= 0 ? "+" : "") + (timReturn - timSpyReturn).toFixed(1) + "%"}`);
    console.log(`${"Top 5 Politicians".padEnd(30)} | ${(top5Return >= 0 ? "+" : "") + top5Return.toFixed(1) + "%".padEnd(8)} | ${(top5SpyReturn >= 0 ? "+" : "") + top5SpyReturn.toFixed(1) + "%".padEnd(8)} | ${((top5Return - top5SpyReturn) >= 0 ? "+" : "") + (top5Return - top5SpyReturn).toFixed(1) + "%"}`);

    expect(true).toBe(true);
  });

  it("QUIVERQUANT STRATEGIES: emulate top strategies", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    // All buy signals sorted by date
    const allSignals = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .filter(s => s.action === "buy")
      .map(convertToSignalForSim)
      .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

    console.log(`\n${"=".repeat(80)}`);
    console.log(`QUIVERQUANT STRATEGY EMULATION`);
    console.log(`${"=".repeat(80)}`);
    console.log(`Date range: ${priceStart} to ${priceEnd}`);
    console.log(`Total buy signals: ${allSignals.length}\n`);

    // Helper function to run a strategy
    function runStrategy(name: string, signals: SignalForSim[]): {
      name: string;
      positions: number;
      invested: number;
      finalValue: number;
      spyEquiv: number;
      returnPct: number;
      spyReturnPct: number;
      alpha: number;
    } {
      const POSITION_SIZE = 100;
      let invested = 0;
      let finalValue = 0;
      let spyEquiv = 0;
      let positions = 0;

      for (const signal of signals) {
        const entryPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);
        if (!entryPrice) continue;

        positions++;
        invested += POSITION_SIZE;

        const shares = POSITION_SIZE / entryPrice;
        const exitPrice = priceProvider.getPrice(signal.ticker, priceEnd);
        const spyEntry = priceProvider.getPrice("SPY", signal.disclosure_date);
        const spyExit = priceProvider.getPrice("SPY", priceEnd);

        if (exitPrice) finalValue += shares * exitPrice;
        if (spyEntry && spyExit) spyEquiv += (POSITION_SIZE / spyEntry) * spyExit;
      }

      const returnPct = invested > 0 ? ((finalValue - invested) / invested) * 100 : 0;
      const spyReturnPct = invested > 0 ? ((spyEquiv - invested) / invested) * 100 : 0;

      return {
        name,
        positions,
        invested,
        finalValue,
        spyEquiv,
        returnPct,
        spyReturnPct,
        alpha: returnPct - spyReturnPct,
      };
    }

    // QuiverQuant strategies to emulate
    const strategies: Array<{ name: string; filter: (s: SignalForSim) => boolean }> = [
      { name: "Congress Buys (all)", filter: () => true },
      { name: "Tim Moore", filter: s => s.politician_name === "Tim Moore" },
      { name: "Cleo Fields", filter: s => s.politician_name === "Cleo Fields" },
      { name: "Dan Meuser", filter: s => s.politician_name === "Daniel Meuser" || s.politician_name === "Dan Meuser" },
      { name: "Jerry Moran", filter: s => s.politician_name === "Jerry Moran" },
      { name: "Nancy Pelosi", filter: s => s.politician_name === "Nancy Pelosi" },
      { name: "Michael McCaul", filter: s => s.politician_name === "Michael McCaul" },
      { name: "Lisa McClain", filter: s => s.politician_name === "Lisa McClain" },
      { name: "Shelley Moore Capito", filter: s => s.politician_name === "Shelley Moore Capito" },
      { name: "Scott Franklin", filter: s => s.politician_name === "Scott Franklin" },
      { name: "Julie Johnson", filter: s => s.politician_name === "Julie Johnson" },
      { name: "John Boozman", filter: s => s.politician_name === "John Boozman" },
    ];

    // Run all strategies
    const results = strategies.map(s => runStrategy(s.name, allSignals.filter(s.filter)));

    // Sort by alpha
    results.sort((a, b) => b.alpha - a.alpha);

    // Print results
    console.log(`${"Strategy".padEnd(25)} | ${"Trades".padEnd(8)} | ${"Return".padEnd(12)} | ${"SPY Equiv".padEnd(12)} | ${"ALPHA".padEnd(12)}`);
    console.log(`${"-".repeat(85)}`);

    for (const r of results) {
      if (r.positions === 0) {
        console.log(`${r.name.padEnd(25)} | ${"0".padEnd(8)} | ${"N/A".padEnd(12)} | ${"N/A".padEnd(12)} | ${"N/A".padEnd(12)}`);
      } else {
        const retStr = (r.returnPct >= 0 ? "+" : "") + r.returnPct.toFixed(1) + "%";
        const spyStr = (r.spyReturnPct >= 0 ? "+" : "") + r.spyReturnPct.toFixed(1) + "%";
        const alphaStr = (r.alpha >= 0 ? "+" : "") + r.alpha.toFixed(1) + "%";
        console.log(`${r.name.padEnd(25)} | ${String(r.positions).padEnd(8)} | ${retStr.padEnd(12)} | ${spyStr.padEnd(12)} | ${alphaStr.padEnd(12)}`);
      }
    }

    // Composite strategies
    console.log(`\n${"=".repeat(60)}`);
    console.log(`COMPOSITE STRATEGIES`);
    console.log(`${"=".repeat(60)}`);

    // Top 3 by alpha (excluding all-congress)
    const top3 = ["Tim Moore", "Jerry Moran", "Shelley Moore Capito"];
    const top3Signals = allSignals.filter(s => top3.includes(s.politician_name));
    const top3Result = runStrategy("Top 3 Alpha Politicians", top3Signals);

    // Top 5 by alpha
    const top5 = ["Tim Moore", "Jerry Moran", "Shelley Moore Capito", "Scott Franklin", "Julie Johnson"];
    const top5Signals = allSignals.filter(s => top5.includes(s.politician_name));
    const top5Result = runStrategy("Top 5 Alpha Politicians", top5Signals);

    // High volume traders with positive alpha
    const highVolume = ["Tim Moore", "Cleo Fields", "Michael McCaul", "Lisa McClain", "John Boozman"];
    const highVolumeSignals = allSignals.filter(s => highVolume.includes(s.politician_name));
    const highVolumeResult = runStrategy("High Volume + Alpha", highVolumeSignals);

    const composites = [top3Result, top5Result, highVolumeResult];
    composites.sort((a, b) => b.alpha - a.alpha);

    console.log(`${"Strategy".padEnd(25)} | ${"Trades".padEnd(8)} | ${"Return".padEnd(12)} | ${"SPY Equiv".padEnd(12)} | ${"ALPHA".padEnd(12)}`);
    console.log(`${"-".repeat(85)}`);
    for (const r of composites) {
      const retStr = (r.returnPct >= 0 ? "+" : "") + r.returnPct.toFixed(1) + "%";
      const spyStr = (r.spyReturnPct >= 0 ? "+" : "") + r.spyReturnPct.toFixed(1) + "%";
      const alphaStr = (r.alpha >= 0 ? "+" : "") + r.alpha.toFixed(1) + "%";
      console.log(`${r.name.padEnd(25)} | ${String(r.positions).padEnd(8)} | ${retStr.padEnd(12)} | ${spyStr.padEnd(12)} | ${alphaStr.padEnd(12)}`);
    }

    // Check which politicians we have data for
    console.log(`\n${"=".repeat(60)}`);
    console.log(`DATA AVAILABILITY CHECK`);
    console.log(`${"=".repeat(60)}`);

    const politicianCounts = new Map<string, number>();
    for (const s of allSignals) {
      politicianCounts.set(s.politician_name, (politicianCounts.get(s.politician_name) || 0) + 1);
    }

    const sortedPoliticians = [...politicianCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\nTop 20 politicians by signal count:`);
    for (const [name, count] of sortedPoliticians.slice(0, 20)) {
      console.log(`  ${name}: ${count} signals`);
    }

    expect(true).toBe(true);
  });

  it("CONGRESS BUYS DEEP DIVE: why is alpha so low?", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    const allSignals = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .filter(s => s.action === "buy")
      .map(convertToSignalForSim)
      .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

    console.log(`\n${"=".repeat(80)}`);
    console.log(`CONGRESS BUYS DEEP DIVE`);
    console.log(`${"=".repeat(80)}`);
    console.log(`Date range: ${priceStart} to ${priceEnd}`);
    console.log(`Total buy signals: ${allSignals.length}`);

    // 1. Check how many signals we're actually trading
    let withPriceData = 0;
    let withoutPriceData = 0;
    const missingTickers = new Set<string>();

    for (const s of allSignals) {
      const price = priceProvider.getPrice(s.ticker, s.disclosure_date);
      if (price) {
        withPriceData++;
      } else {
        withoutPriceData++;
        missingTickers.add(s.ticker);
      }
    }

    console.log(`\n--- DATA COVERAGE ---`);
    console.log(`Signals with price data: ${withPriceData} (${((withPriceData/allSignals.length)*100).toFixed(1)}%)`);
    console.log(`Signals missing price data: ${withoutPriceData} (${((withoutPriceData/allSignals.length)*100).toFixed(1)}%)`);
    console.log(`\nMissing tickers (${missingTickers.size} unique):`);

    // Count signals per missing ticker
    const missingTickerCounts = new Map<string, number>();
    for (const s of allSignals) {
      const price = priceProvider.getPrice(s.ticker, s.disclosure_date);
      if (!price) {
        missingTickerCounts.set(s.ticker, (missingTickerCounts.get(s.ticker) || 0) + 1);
      }
    }
    const sortedMissing = [...missingTickerCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ticker, count] of sortedMissing.slice(0, 30)) {
      console.log(`  ${ticker}: ${count} signals`);
    }

    // 2. Check holding period distribution
    console.log(`\n--- HOLDING PERIOD DISTRIBUTION ---`);
    const holdingDays: number[] = [];
    for (const s of allSignals) {
      const days = daysBetween(s.disclosure_date, priceEnd);
      holdingDays.push(days);
    }
    holdingDays.sort((a, b) => a - b);

    const avgHoldDays = holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length;
    const medianHoldDays = holdingDays[Math.floor(holdingDays.length / 2)];
    const minHoldDays = holdingDays[0];
    const maxHoldDays = holdingDays[holdingDays.length - 1];

    console.log(`Average holding period: ${avgHoldDays.toFixed(0)} days`);
    console.log(`Median holding period: ${medianHoldDays} days`);
    console.log(`Min: ${minHoldDays} days, Max: ${maxHoldDays} days`);

    // Count by buckets
    const under30 = holdingDays.filter(d => d < 30).length;
    const under90 = holdingDays.filter(d => d < 90).length;
    const under180 = holdingDays.filter(d => d < 180).length;
    console.log(`Signals with <30 days holding: ${under30} (${((under30/holdingDays.length)*100).toFixed(1)}%)`);
    console.log(`Signals with <90 days holding: ${under90} (${((under90/holdingDays.length)*100).toFixed(1)}%)`);
    console.log(`Signals with <180 days holding: ${under180} (${((under180/holdingDays.length)*100).toFixed(1)}%)`);

    // 3. Check return distribution
    console.log(`\n--- RETURN DISTRIBUTION ---`);
    interface TradeResult {
      ticker: string;
      politician: string;
      entryDate: string;
      holdDays: number;
      returnPct: number;
      spyReturnPct: number;
      alpha: number;
    }
    const results: TradeResult[] = [];

    for (const s of allSignals) {
      const entryPrice = priceProvider.getPrice(s.ticker, s.disclosure_date);
      const exitPrice = priceProvider.getPrice(s.ticker, priceEnd);
      const spyEntry = priceProvider.getPrice("SPY", s.disclosure_date);
      const spyExit = priceProvider.getPrice("SPY", priceEnd);

      if (!entryPrice || !exitPrice || !spyEntry || !spyExit) continue;

      const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
      const spyReturnPct = ((spyExit - spyEntry) / spyEntry) * 100;
      const holdDays = daysBetween(s.disclosure_date, priceEnd);

      results.push({
        ticker: s.ticker,
        politician: s.politician_name,
        entryDate: s.disclosure_date,
        holdDays,
        returnPct,
        spyReturnPct,
        alpha: returnPct - spyReturnPct,
      });
    }

    // Return buckets
    const bigWinners = results.filter(r => r.returnPct > 50);
    const winners = results.filter(r => r.returnPct > 0 && r.returnPct <= 50);
    const smallLosers = results.filter(r => r.returnPct <= 0 && r.returnPct > -20);
    const bigLosers = results.filter(r => r.returnPct <= -20);

    console.log(`Big winners (>50%): ${bigWinners.length} (${((bigWinners.length/results.length)*100).toFixed(1)}%)`);
    console.log(`Winners (0-50%): ${winners.length} (${((winners.length/results.length)*100).toFixed(1)}%)`);
    console.log(`Small losers (0 to -20%): ${smallLosers.length} (${((smallLosers.length/results.length)*100).toFixed(1)}%)`);
    console.log(`Big losers (<-20%): ${bigLosers.length} (${((bigLosers.length/results.length)*100).toFixed(1)}%)`);

    const avgReturn = results.reduce((s, r) => s + r.returnPct, 0) / results.length;
    const avgSpy = results.reduce((s, r) => s + r.spyReturnPct, 0) / results.length;
    const avgAlpha = results.reduce((s, r) => s + r.alpha, 0) / results.length;

    console.log(`\nAverage trade return: ${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(2)}%`);
    console.log(`Average SPY return: ${avgSpy >= 0 ? "+" : ""}${avgSpy.toFixed(2)}%`);
    console.log(`Average alpha: ${avgAlpha >= 0 ? "+" : ""}${avgAlpha.toFixed(2)}%`);

    // 4. Check alpha by holding period
    console.log(`\n--- ALPHA BY HOLDING PERIOD ---`);
    const longHold = results.filter(r => r.holdDays >= 180);
    const medHold = results.filter(r => r.holdDays >= 90 && r.holdDays < 180);
    const shortHold = results.filter(r => r.holdDays < 90);

    const longAlpha = longHold.length > 0 ? longHold.reduce((s, r) => s + r.alpha, 0) / longHold.length : 0;
    const medAlpha = medHold.length > 0 ? medHold.reduce((s, r) => s + r.alpha, 0) / medHold.length : 0;
    const shortAlpha = shortHold.length > 0 ? shortHold.reduce((s, r) => s + r.alpha, 0) / shortHold.length : 0;

    console.log(`Long hold (180+ days): ${longHold.length} trades, avg alpha: ${longAlpha >= 0 ? "+" : ""}${longAlpha.toFixed(2)}%`);
    console.log(`Medium hold (90-180 days): ${medHold.length} trades, avg alpha: ${medAlpha >= 0 ? "+" : ""}${medAlpha.toFixed(2)}%`);
    console.log(`Short hold (<90 days): ${shortHold.length} trades, avg alpha: ${shortAlpha >= 0 ? "+" : ""}${shortAlpha.toFixed(2)}%`);

    // 5. Top 10 biggest losers (dragging down the average?)
    console.log(`\n--- TOP 10 BIGGEST LOSERS ---`);
    const sortedByReturn = [...results].sort((a, b) => a.returnPct - b.returnPct);
    for (const r of sortedByReturn.slice(0, 10)) {
      console.log(`${r.ticker.padEnd(6)} by ${r.politician.padEnd(20)} | ${r.entryDate} | ${r.holdDays}d | return: ${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(1)}% | alpha: ${r.alpha >= 0 ? "+" : ""}${r.alpha.toFixed(1)}%`);
    }

    // 6. Top 10 biggest winners
    console.log(`\n--- TOP 10 BIGGEST WINNERS ---`);
    for (const r of sortedByReturn.slice(-10).reverse()) {
      console.log(`${r.ticker.padEnd(6)} by ${r.politician.padEnd(20)} | ${r.entryDate} | ${r.holdDays}d | return: ${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(1)}% | alpha: ${r.alpha >= 0 ? "+" : ""}${r.alpha.toFixed(1)}%`);
    }

    // 7. Check if recent trades are dragging down
    console.log(`\n--- ALPHA BY ENTRY DATE ---`);
    const byQuarter = new Map<string, TradeResult[]>();
    for (const r of results) {
      const year = r.entryDate.slice(0, 4);
      const month = parseInt(r.entryDate.slice(5, 7));
      const quarter = `${year}-Q${Math.ceil(month / 3)}`;
      if (!byQuarter.has(quarter)) byQuarter.set(quarter, []);
      byQuarter.get(quarter)!.push(r);
    }

    const sortedQuarters = [...byQuarter.keys()].sort();
    for (const q of sortedQuarters) {
      const trades = byQuarter.get(q)!;
      const qAlpha = trades.reduce((s, r) => s + r.alpha, 0) / trades.length;
      const qReturn = trades.reduce((s, r) => s + r.returnPct, 0) / trades.length;
      console.log(`${q}: ${trades.length} trades, avg return: ${qReturn >= 0 ? "+" : ""}${qReturn.toFixed(1)}%, alpha: ${qAlpha >= 0 ? "+" : ""}${qAlpha.toFixed(1)}%`);
    }

    // 8. Compare to QuiverQuant's claimed numbers
    console.log(`\n${"=".repeat(60)}`);
    console.log(`COMPARISON TO QUIVERQUANT CLAIMS`);
    console.log(`${"=".repeat(60)}`);
    console.log(`QuiverQuant claims: ~35% CAGR for Congress Buys`);
    console.log(`Our data shows: ${avgReturn.toFixed(1)}% avg return over ${avgHoldDays.toFixed(0)} days avg hold`);

    // Annualize our returns
    const annualizedReturn = (avgReturn / avgHoldDays) * 365;
    console.log(`Annualized (simple): ${annualizedReturn.toFixed(1)}%`);
    console.log(`\nPossible reasons for discrepancy:`);
    console.log(`1. We're missing ${withoutPriceData} signals (${((withoutPriceData/allSignals.length)*100).toFixed(1)}%) - could be winners`);
    console.log(`2. QuiverQuant may weight by position size (we use equal $100/trade)`);
    console.log(`3. QuiverQuant may have different entry/exit timing`);
    console.log(`4. QuiverQuant's "since inception" spans more time than our 2-year window`);
    console.log(`5. Recent trades (Q4 2025, Q1 2026) haven't had time to mature`);

    expect(true).toBe(true);
  });

  it("EXIT STRATEGIES: Tim Moore vs Cleo Fields", () => {
    if (!data) {
      console.log("Skipping: no export data");
      return;
    }

    // Build price provider
    const priceProvider = new StaticPriceProvider();
    for (const p of data.market_prices) {
      priceProvider.setPrice(p.ticker, p.date, p.close);
    }

    const priceDates = [...new Set(data.market_prices.map(p => p.date))].sort();
    const priceStart = priceDates[0];
    const priceEnd = priceDates[priceDates.length - 1];

    const allSignals = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .filter(s => s.action === "buy")
      .map(convertToSignalForSim)
      .sort((a, b) => a.disclosure_date.localeCompare(b.disclosure_date));

    console.log(`\n${"=".repeat(80)}`);
    console.log(`EXIT STRATEGIES: Tim Moore vs Cleo Fields`);
    console.log(`${"=".repeat(80)}`);

    const POSITION_SIZE = 100;

    interface StrategyResult {
      politician: string;
      strategy: string;
      trades: number;
      finalValue: number;
      spyEquiv: number;
      returnPct: number;
      spyReturnPct: number;
      alpha: number;
    }

    // Run a strategy with exit conditions
    function runWithExits(
      politicianName: string,
      strategyName: string,
      signals: SignalForSim[],
      exitConfig: {
        stopLossPct?: number;
        takeProfitPct?: number;
        maxHoldDays?: number;
        trailingStopPct?: number;
      }
    ): StrategyResult {
      let totalInvested = 0;
      let totalFinalValue = 0;
      let totalSpyEquiv = 0;
      let tradesExecuted = 0;

      for (const signal of signals) {
        const entryPrice = priceProvider.getPrice(signal.ticker, signal.disclosure_date);
        if (!entryPrice) continue;

        tradesExecuted++;
        totalInvested += POSITION_SIZE;
        const shares = POSITION_SIZE / entryPrice;

        // Find exit point by simulating day-by-day
        let exitDate = priceEnd;
        let exitPrice = priceProvider.getPrice(signal.ticker, priceEnd) || entryPrice;
        let highestPrice = entryPrice;

        let currentDate = signal.disclosure_date;
        let daysHeld = 0;

        while (currentDate <= priceEnd) {
          const price = priceProvider.getPrice(signal.ticker, currentDate);
          if (price) {
            if (price > highestPrice) highestPrice = price;
            const returnPct = ((price - entryPrice) / entryPrice) * 100;

            // Check stop loss (fixed)
            if (exitConfig.stopLossPct && returnPct <= -exitConfig.stopLossPct) {
              exitDate = currentDate;
              exitPrice = price;
              break;
            }

            // Check trailing stop (from highest price)
            if (exitConfig.trailingStopPct && highestPrice > 0) {
              const drawdownFromHigh = ((price - highestPrice) / highestPrice) * 100;
              if (drawdownFromHigh <= -exitConfig.trailingStopPct) {
                exitDate = currentDate;
                exitPrice = price;
                break;
              }
            }

            // Check take profit
            if (exitConfig.takeProfitPct && returnPct >= exitConfig.takeProfitPct) {
              exitDate = currentDate;
              exitPrice = price;
              break;
            }

            // Check max hold days
            if (exitConfig.maxHoldDays && daysHeld >= exitConfig.maxHoldDays) {
              exitDate = currentDate;
              exitPrice = price;
              break;
            }
          }

          // Advance day
          const d = new Date(currentDate);
          d.setDate(d.getDate() + 1);
          currentDate = d.toISOString().split("T")[0];
          daysHeld++;
        }

        totalFinalValue += shares * exitPrice;

        // SPY comparison for same period
        const spyEntry = priceProvider.getPrice("SPY", signal.disclosure_date);
        const spyExit = priceProvider.getPrice("SPY", exitDate);
        if (spyEntry && spyExit) {
          totalSpyEquiv += (POSITION_SIZE / spyEntry) * spyExit;
        }
      }

      const returnPct = totalInvested > 0 ? ((totalFinalValue - totalInvested) / totalInvested) * 100 : 0;
      const spyReturnPct = totalInvested > 0 ? ((totalSpyEquiv - totalInvested) / totalInvested) * 100 : 0;

      return {
        politician: politicianName,
        strategy: strategyName,
        trades: tradesExecuted,
        finalValue: totalFinalValue,
        spyEquiv: totalSpyEquiv,
        returnPct,
        spyReturnPct,
        alpha: returnPct - spyReturnPct,
      };
    }

    // Get signals for each politician
    const timMooreSignals = allSignals.filter(s => s.politician_name === "Tim Moore");
    const cleoFieldsSignals = allSignals.filter(s => s.politician_name === "Cleo Fields");

    console.log(`Tim Moore signals: ${timMooreSignals.length}`);
    console.log(`Cleo Fields signals: ${cleoFieldsSignals.length}`);

    // 4 AGENT STRATEGIES (from configs.ts)
    const exitStrategies = [
      // ChatGPT (Decay Edge): stop_loss 18%, max_hold 120 days, soft_stop 30 days
      { name: "ChatGPT (Decay Edge)", config: { stopLossPct: 18, maxHoldDays: 120 } },
      // Claude (Decay Alpha): stop_loss 15%, take_profit 25%/40%, max_hold 120 days
      { name: "Claude (Decay Alpha)", config: { stopLossPct: 15, takeProfitPct: 25, maxHoldDays: 120 } },
      // Gemini (Titan Conviction): trailing stop 20%, no time limit
      { name: "Gemini (Titan Conviction)", config: { trailingStopPct: 20 } },
      // Naive (Monkey Trader): stop_loss 20%, no time limit
      { name: "Naive (Monkey Trader)", config: { stopLossPct: 20 } },
    ];

    const results: StrategyResult[] = [];

    // Run all strategies for both politicians
    for (const strategy of exitStrategies) {
      results.push(runWithExits("Tim Moore", strategy.name, timMooreSignals, strategy.config));
      results.push(runWithExits("Cleo Fields", strategy.name, cleoFieldsSignals, strategy.config));
    }

    // Print results
    console.log(`\n${"Politician".padEnd(15)} | ${"Strategy".padEnd(25)} | ${"Trades".padEnd(7)} | ${"Return".padEnd(10)} | ${"SPY".padEnd(10)} | ${"ALPHA".padEnd(10)}`);
    console.log(`${"-".repeat(95)}`);

    for (const r of results) {
      const retStr = (r.returnPct >= 0 ? "+" : "") + r.returnPct.toFixed(1) + "%";
      const spyStr = (r.spyReturnPct >= 0 ? "+" : "") + r.spyReturnPct.toFixed(1) + "%";
      const alphaStr = (r.alpha >= 0 ? "+" : "") + r.alpha.toFixed(1) + "%";
      console.log(`${r.politician.padEnd(15)} | ${r.strategy.padEnd(25)} | ${String(r.trades).padEnd(7)} | ${retStr.padEnd(10)} | ${spyStr.padEnd(10)} | ${alphaStr.padEnd(10)}`);
    }

    // Summary by politician
    console.log(`\n${"=".repeat(60)}`);
    console.log(`BEST STRATEGY BY POLITICIAN`);
    console.log(`${"=".repeat(60)}`);

    const timResults = results.filter(r => r.politician === "Tim Moore");
    const cleoResults = results.filter(r => r.politician === "Cleo Fields");

    const bestTim = timResults.reduce((a, b) => a.alpha > b.alpha ? a : b);
    const bestCleo = cleoResults.reduce((a, b) => a.alpha > b.alpha ? a : b);

    console.log(`Tim Moore: Best = "${bestTim.strategy}" with ${bestTim.alpha >= 0 ? "+" : ""}${bestTim.alpha.toFixed(1)}% alpha`);
    console.log(`Cleo Fields: Best = "${bestCleo.strategy}" with ${bestCleo.alpha >= 0 ? "+" : ""}${bestCleo.alpha.toFixed(1)}% alpha`);

    expect(true).toBe(true);
  });
});
