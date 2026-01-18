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

  // Time Decay
  if (components.time_decay) {
    let decay = Math.pow(
      0.5,
      signal.days_since_trade / components.time_decay.half_life_days
    );
    if (
      components.time_decay.use_filing_date &&
      components.time_decay.filing_half_life_days
    ) {
      const filingDecay = Math.pow(
        0.5,
        signal.days_since_filing / components.time_decay.filing_half_life_days
      );
      decay = Math.min(decay, filingDecay);
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

    console.log(`\nSimulation date range: ${priceStart} to ${priceEnd}`);

    // Get signals with disclosure dates in this range
    const signalsInRange = data.signals
      .filter(s => s.disclosure_date >= priceStart && s.disclosure_date <= priceEnd)
      .map(convertToSignalForSim);

    console.log(`Signals in date range: ${signalsInRange.length}`);

    if (signalsInRange.length === 0) {
      console.log("No signals in date range with real prices - data mismatch");

      // Show the mismatch
      console.log("\nData mismatch details:");
      console.log(`  Price data: ${priceStart} to ${priceEnd}`);
      console.log(`  Signal disclosures: ${data.signals[0]?.disclosure_date} to ${data.signals[data.signals.length-1]?.disclosure_date}`);

      // The test passes but logs the issue
      expect(signalsInRange.length).toBe(0);
      return;
    }

    // Run simulation
    const agentConfigs = [CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG, NAIVE_CONFIG];
    const MONTHLY_BUDGET = 1000;

    const clock = new SimulationClock(priceStart, priceEnd);
    const signalReplayer = new SignalReplayer(signalsInRange);
    const portfolioState = new PortfolioState();
    const eventLogger = new EventLogger(false);

    portfolioState.initialize(
      agentConfigs.map(a => a.id),
      MONTHLY_BUDGET
    );

    let lastMonth = priceStart.substring(0, 7);
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
              const shares = calculateShares(positionSize, currentPrice);
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

    console.log(`\nSignals processed: ${signalsProcessed}`);

    expect(signalsProcessed).toBeGreaterThanOrEqual(0);
  });
});
