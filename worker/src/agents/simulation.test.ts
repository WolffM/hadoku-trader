/**
 * Simulation Test - 3-Month Backtesting Framework
 * Validates the multi-agent trading engine by replaying historical signals.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SimulationClock,
  SignalReplayer,
  PortfolioState,
  EventLogger,
  generateSimId,
  daysBetween,
  type SignalForSim,
} from "./simulation";
import { MockPriceProvider, StaticPriceProvider } from "./priceProvider";
import { CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG } from "./configs";
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
// Test Signal Data
// =============================================================================

/**
 * Generate realistic test signals spanning 3 months.
 * Based on typical congressional trading patterns.
 */
function generateTestSignals(): SignalForSim[] {
  const signals: SignalForSim[] = [];
  const startDate = new Date("2025-10-16");
  const endDate = new Date("2026-01-16");

  // Common tickers and politicians
  const tickers = [
    { ticker: "NVDA", basePrice: 480 },
    { ticker: "MSFT", basePrice: 415 },
    { ticker: "AAPL", basePrice: 225 },
    { ticker: "AMZN", basePrice: 185 },
    { ticker: "GOOGL", basePrice: 170 },
    { ticker: "META", basePrice: 540 },
    { ticker: "TSLA", basePrice: 250 },
    { ticker: "AMD", basePrice: 145 },
    { ticker: "INTC", basePrice: 22 },
    { ticker: "CRM", basePrice: 285 },
  ];

  const politicians = [
    { name: "Nancy Pelosi", party: "D", frequency: 0.15 },
    { name: "Mark Green", party: "R", frequency: 0.12 },
    { name: "Michael McCaul", party: "R", frequency: 0.10 },
    { name: "Ro Khanna", party: "D", frequency: 0.08 },
    { name: "Rick Larsen", party: "D", frequency: 0.08 },
    { name: "Josh Gottheimer", party: "D", frequency: 0.07 },
    { name: "Dan Crenshaw", party: "R", frequency: 0.05 },
    { name: "Tommy Tuberville", party: "R", frequency: 0.05 },
    { name: "Virginia Foxx", party: "R", frequency: 0.04 },
    { name: "Kevin Hern", party: "R", frequency: 0.04 },
  ];

  const sources = ["capitol_trades", "senate_stock_watcher", "house_stock_watcher"];

  const positionSizes = [
    { min: 1001, max: 15000 },
    { min: 15001, max: 50000 },
    { min: 50001, max: 100000 },
    { min: 100001, max: 250000 },
    { min: 250001, max: 500000 },
  ];

  // Seed random for reproducibility
  let seed = 42;
  const seededRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10000;
  };

  // Generate signals for each day
  const currentDate = new Date(startDate);
  let signalId = 1;

  while (currentDate <= endDate) {
    // Skip weekends
    const day = currentDate.getDay();
    if (day === 0 || day === 6) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }

    // Generate 2-8 signals per day
    const signalsToday = Math.floor(seededRandom() * 7) + 2;

    for (let i = 0; i < signalsToday; i++) {
      // Pick random components
      const tickerData = tickers[Math.floor(seededRandom() * tickers.length)];
      const politician = politicians.find(
        (p) => seededRandom() < p.frequency
      ) || politicians[Math.floor(seededRandom() * politicians.length)];
      const source = sources[Math.floor(seededRandom() * sources.length)];
      const positionSize = positionSizes[Math.floor(seededRandom() * positionSizes.length)];

      // 75% buys, 25% sells
      const action = seededRandom() > 0.25 ? "buy" : "sell";

      // Filing date is 1-30 days after trade date
      const filingDelay = Math.floor(seededRandom() * 30) + 1;
      const filingDate = new Date(currentDate);
      filingDate.setDate(filingDate.getDate() + filingDelay);

      // Disclosed price is the base price with some variation
      const priceVariation = (seededRandom() - 0.5) * 0.1;
      const disclosedPrice = tickerData.basePrice * (1 + priceVariation);

      signals.push({
        id: `sig_${signalId++}`,
        ticker: tickerData.ticker,
        action: action as "buy" | "sell",
        asset_type: "stock",
        disclosed_price: Math.round(disclosedPrice * 100) / 100,
        disclosed_date: currentDate.toISOString().split("T")[0],
        filing_date: filingDate.toISOString().split("T")[0],
        position_size_min: positionSize.min,
        politician_name: politician.name,
        source,
      });
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return signals;
}

// =============================================================================
// Simulation Signal Processing (No DB Dependencies)
// =============================================================================

/**
 * Enrich a signal for simulation with computed fields.
 */
function enrichSignalForSim(
  signal: SignalForSim,
  currentPrice: number,
  currentDate: string
): EnrichedSignal {
  const daysSinceTrade = daysBetween(signal.disclosed_date, currentDate);
  const daysSinceFiling = daysBetween(signal.filing_date, currentDate);
  const priceChangePct =
    ((currentPrice - signal.disclosed_price) / signal.disclosed_price) * 100;

  return {
    id: signal.id,
    ticker: signal.ticker,
    action: signal.action,
    asset_type: signal.asset_type as "stock" | "etf" | "option",
    disclosed_price: signal.disclosed_price,
    current_price: currentPrice,
    trade_date: signal.disclosed_date,
    filing_date: signal.filing_date,
    position_size_min: signal.position_size_min,
    politician_name: signal.politician_name,
    source: signal.source,
    days_since_trade: daysSinceTrade,
    days_since_filing: Math.max(daysSinceFiling, 0),
    price_change_pct: priceChangePct,
  };
}

/**
 * Calculate score for simulation (simplified - no DB lookups).
 */
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

/**
 * Process a signal for a single agent (simulation version).
 */
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

/**
 * Check exit conditions for simulation.
 */
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
// Unit Tests for Simulation Components
// =============================================================================

describe("SimulationClock", () => {
  it("should track date correctly", () => {
    const clock = new SimulationClock("2025-10-16", "2026-01-16");
    expect(clock.getDate()).toBe("2025-10-16");
    expect(clock.getStartDate()).toBe("2025-10-16");
    expect(clock.getEndDate()).toBe("2026-01-16");
  });

  it("should advance days correctly", () => {
    const clock = new SimulationClock("2025-10-16", "2026-01-16");
    clock.advance(1);
    expect(clock.getDate()).toBe("2025-10-17");
    clock.advance(7);
    expect(clock.getDate()).toBe("2025-10-24");
  });

  it("should identify market days", () => {
    const clock = new SimulationClock("2025-10-17", "2026-01-16"); // Friday
    expect(clock.isMarketDay()).toBe(true);
    clock.advance(1); // Saturday
    expect(clock.isMarketDay()).toBe(false);
    clock.advance(1); // Sunday
    expect(clock.isMarketDay()).toBe(false);
    clock.advance(1); // Monday
    expect(clock.isMarketDay()).toBe(true);
  });

  it("should detect completion", () => {
    const clock = new SimulationClock("2026-01-15", "2026-01-16");
    expect(clock.isComplete()).toBe(false);
    clock.advance(1);
    expect(clock.isComplete()).toBe(false);
    clock.advance(1);
    expect(clock.isComplete()).toBe(true);
  });
});

describe("SignalReplayer", () => {
  const testSignals: SignalForSim[] = [
    {
      id: "sig_1",
      ticker: "NVDA",
      action: "buy",
      asset_type: "stock",
      disclosed_price: 100,
      disclosed_date: "2025-10-16",
      filing_date: "2025-10-20",
      position_size_min: 50000,
      politician_name: "Nancy Pelosi",
      source: "capitol_trades",
    },
    {
      id: "sig_2",
      ticker: "MSFT",
      action: "buy",
      asset_type: "stock",
      disclosed_price: 400,
      disclosed_date: "2025-10-17",
      filing_date: "2025-10-25",
      position_size_min: 100000,
      politician_name: "Mark Green",
      source: "senate_stock_watcher",
    },
  ];

  it("should return signals for current date", () => {
    const replayer = new SignalReplayer(testSignals);
    const signals = replayer.getSignalsForDate("2025-10-16");
    expect(signals.length).toBe(1);
    expect(signals[0].id).toBe("sig_1");
  });

  it("should return multiple signals if date is later", () => {
    const replayer = new SignalReplayer(testSignals);
    const signals = replayer.getSignalsForDate("2025-10-18");
    expect(signals.length).toBe(2);
  });

  it("should not return processed signals", () => {
    const replayer = new SignalReplayer(testSignals);
    replayer.markProcessed("sig_1");
    const signals = replayer.getSignalsForDate("2025-10-18");
    expect(signals.length).toBe(1);
    expect(signals[0].id).toBe("sig_2");
  });
});

describe("PortfolioState", () => {
  let portfolio: PortfolioState;

  beforeEach(() => {
    portfolio = new PortfolioState();
    portfolio.initialize(["chatgpt", "claude", "gemini"], 1000);
  });

  it("should initialize portfolios correctly", () => {
    expect(portfolio.getCash("chatgpt")).toBe(1000);
    expect(portfolio.getCash("claude")).toBe(1000);
    expect(portfolio.getCash("gemini")).toBe(1000);
  });

  it("should add positions and deduct cash", () => {
    const position: SimPosition = {
      id: "pos_1",
      ticker: "NVDA",
      shares: 2,
      entryPrice: 100,
      entryDate: "2025-10-16",
      currentPrice: 100,
      highestPrice: 100,
      partialSold: false,
      signalId: "sig_1",
    };
    portfolio.addPosition("chatgpt", position);
    expect(portfolio.getCash("chatgpt")).toBe(800); // 1000 - 200
    expect(portfolio.getPortfolio("chatgpt").positions.length).toBe(1);
  });

  it("should close positions and add proceeds", () => {
    const position: SimPosition = {
      id: "pos_1",
      ticker: "NVDA",
      shares: 2,
      entryPrice: 100,
      entryDate: "2025-10-16",
      currentPrice: 110,
      highestPrice: 110,
      partialSold: false,
      signalId: "sig_1",
    };
    portfolio.addPosition("chatgpt", position);
    expect(portfolio.getCash("chatgpt")).toBe(800);

    portfolio.closePosition("chatgpt", "pos_1", 110, "2025-10-20", "stop_loss");
    expect(portfolio.getCash("chatgpt")).toBe(1020); // 800 + 220
    expect(portfolio.getPortfolio("chatgpt").positions.length).toBe(0);
    expect(portfolio.getPortfolio("chatgpt").closedPositions.length).toBe(1);
  });

  it("should add monthly budget (not reset)", () => {
    portfolio.addPosition("chatgpt", {
      id: "pos_1",
      ticker: "NVDA",
      shares: 2,
      entryPrice: 100,
      entryDate: "2025-10-16",
      currentPrice: 100,
      highestPrice: 100,
      partialSold: false,
      signalId: "sig_1",
    });
    expect(portfolio.getCash("chatgpt")).toBe(800);

    // Add monthly budget
    portfolio.addMonthlyBudget("chatgpt", 1000);
    expect(portfolio.getCash("chatgpt")).toBe(1800);
  });
});

describe("MockPriceProvider", () => {
  const testSignals: SignalForSim[] = [
    {
      id: "sig_1",
      ticker: "NVDA",
      action: "buy",
      asset_type: "stock",
      disclosed_price: 100,
      disclosed_date: "2025-10-16",
      filing_date: "2025-10-20",
      position_size_min: 50000,
      politician_name: "Nancy Pelosi",
      source: "capitol_trades",
    },
  ];

  it("should generate prices for tickers", () => {
    const provider = new MockPriceProvider(testSignals, 42);
    const price = provider.getPrice("NVDA", "2025-10-16");
    expect(price).not.toBeNull();
    expect(price).toBeCloseTo(100, 0);
  });

  it("should be deterministic with same seed", () => {
    const provider1 = new MockPriceProvider(testSignals, 42);
    const provider2 = new MockPriceProvider(testSignals, 42);

    const price1 = provider1.getPrice("NVDA", "2025-10-20");
    const price2 = provider2.getPrice("NVDA", "2025-10-20");

    expect(price1).toBe(price2);
  });

  it("should generate different prices with different seeds", () => {
    const provider1 = new MockPriceProvider(testSignals, 42);
    const provider2 = new MockPriceProvider(testSignals, 123);

    const price1 = provider1.getPrice("NVDA", "2025-10-30");
    const price2 = provider2.getPrice("NVDA", "2025-10-30");

    expect(price1).not.toBe(price2);
  });
});

// =============================================================================
// Full Simulation Test
// =============================================================================

describe("Strategy Simulation", () => {
  const agentConfigs = [CHATGPT_CONFIG, CLAUDE_CONFIG, GEMINI_CONFIG];
  const MONTHLY_BUDGET = 1000;

  it("should run 3-month simulation without errors", () => {
    // Generate test data
    const testSignals = generateTestSignals();
    console.log(`\nGenerated ${testSignals.length} test signals`);

    // Initialize simulation components
    const clock = new SimulationClock("2025-10-16", "2026-01-16");
    const priceProvider = new MockPriceProvider(testSignals, 42);
    const signalReplayer = new SignalReplayer(testSignals);
    const portfolioState = new PortfolioState();
    const eventLogger = new EventLogger(false); // Set to true for verbose output

    portfolioState.initialize(
      agentConfigs.map((a) => a.id),
      MONTHLY_BUDGET
    );

    // Track for monthly budget additions
    let lastMonth = "2025-10";
    let signalsProcessed = 0;

    // Run simulation day by day
    while (!clock.isComplete()) {
      const currentDate = clock.getDate();

      // Skip weekends
      if (!clock.isMarketDay()) {
        clock.advance();
        continue;
      }

      // Check for new month - add budget
      const currentMonth = currentDate.substring(0, 7);
      if (portfolioState.isNewMonth(currentDate, `${lastMonth}-01`)) {
        for (const agent of agentConfigs) {
          portfolioState.addMonthlyBudget(agent.id, MONTHLY_BUDGET);
        }
        lastMonth = currentMonth;
      }

      // Get signals available on this date
      const signals = signalReplayer.getSignalsForDate(currentDate);

      // Count accepted signals per agent for equal_split sizing
      const acceptedCounts = new Map<string, number>();
      for (const agent of agentConfigs) {
        acceptedCounts.set(agent.id, 0);
      }

      for (const signal of signals) {
        // Get current price for the ticker
        const currentPrice = priceProvider.getPrice(signal.ticker, currentDate);
        if (currentPrice === null) continue;

        // Enrich signal
        const enriched = enrichSignalForSim(signal, currentPrice, currentDate);

        // Log signal
        eventLogger.logSignalReceived(currentDate, signal);

        // Process for each agent
        for (const agent of agentConfigs) {
          const portfolio = portfolioState.getPortfolio(agent.id);
          const openPositions = portfolio.positions.length;
          const tickerPositions = portfolio.positions.filter(
            (p) => p.ticker === signal.ticker
          ).length;

          // Make decision
          const decision = processSignalForAgentSim(
            agent,
            enriched,
            openPositions,
            tickerPositions
          );

          // Log decision
          const breakdown =
            decision.score_breakdown as ScoreBreakdown | undefined;
          eventLogger.logDecision(
            currentDate,
            agent.id,
            signal,
            decision,
            breakdown
          );

          // Execute if decided
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

      // End of day: update prices and check exits
      for (const agent of agentConfigs) {
        const portfolio = portfolioState.getPortfolio(agent.id);
        const tickers = portfolio.positions.map((p) => p.ticker);
        const prices = priceProvider.getClosingPrices(tickers, currentDate);

        portfolioState.updatePrices(agent.id, prices);

        // Check exits for each position
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

        // Execute exits
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

        // Take daily snapshot
        portfolioState.snapshot(agent.id, currentDate);
      }

      // Log daily summary
      eventLogger.logDailySummary(currentDate, portfolioState.getAllPortfolios());

      clock.advance();
    }

    // Generate and print report
    clock.reset();
    const report = eventLogger.getReport(clock, portfolioState);
    eventLogger.printReport(report);

    // Assertions
    expect(report.marketDays).toBeGreaterThan(50);
    expect(signalsProcessed).toBeGreaterThan(0);

    // Check each agent has some activity
    for (const agentId of ["chatgpt", "claude", "gemini"]) {
      const metrics = report.agentResults[agentId];
      expect(metrics).toBeDefined();

      // Print detailed results
      console.log(`\n${agentId.toUpperCase()} Detailed:`);
      console.log(
        `  Total Trades: ${metrics.totalTrades}`
      );
      console.log(
        `  Win Rate: ${metrics.winRate.toFixed(1)}%`
      );
      console.log(
        `  Avg Win: ${metrics.avgWinPct.toFixed(2)}%`
      );
      console.log(
        `  Avg Loss: ${metrics.avgLossPct.toFixed(2)}%`
      );
    }
  });

  it("should compare agent strategies", () => {
    const testSignals = generateTestSignals();
    const clock = new SimulationClock("2025-10-16", "2026-01-16");
    const priceProvider = new MockPriceProvider(testSignals, 42);
    const signalReplayer = new SignalReplayer(testSignals);
    const portfolioState = new PortfolioState();

    portfolioState.initialize(
      agentConfigs.map((a) => a.id),
      MONTHLY_BUDGET
    );

    let lastMonth = "2025-10";

    while (!clock.isComplete()) {
      const currentDate = clock.getDate();

      if (!clock.isMarketDay()) {
        clock.advance();
        continue;
      }

      const currentMonth = currentDate.substring(0, 7);
      if (portfolioState.isNewMonth(currentDate, `${lastMonth}-01`)) {
        for (const agent of agentConfigs) {
          portfolioState.addMonthlyBudget(agent.id, MONTHLY_BUDGET);
        }
        lastMonth = currentMonth;
      }

      const signals = signalReplayer.getSignalsForDate(currentDate);
      const acceptedCounts = new Map<string, number>();

      for (const signal of signals) {
        const currentPrice = priceProvider.getPrice(signal.ticker, currentDate);
        if (currentPrice === null) continue;

        const enriched = enrichSignalForSim(signal, currentPrice, currentDate);

        for (const agent of agentConfigs) {
          const portfolio = portfolioState.getPortfolio(agent.id);
          const decision = processSignalForAgentSim(
            agent,
            enriched,
            portfolio.positions.length,
            portfolio.positions.filter((p) => p.ticker === signal.ticker).length
          );

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
                portfolioState.addPosition(agent.id, {
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
              }
            }
          }
        }

        signalReplayer.markProcessed(signal.id);
      }

      // Update prices and check exits
      for (const agent of agentConfigs) {
        const portfolio = portfolioState.getPortfolio(agent.id);
        const tickers = portfolio.positions.map((p) => p.ticker);
        const prices = priceProvider.getClosingPrices(tickers, currentDate);

        portfolioState.updatePrices(agent.id, prices);

        for (const position of [...portfolio.positions]) {
          const price = prices.get(position.ticker);
          if (price === undefined) continue;

          const exit = checkExitConditionsForSim(position, agent, price, currentDate);
          if (exit) {
            portfolioState.closePosition(
              agent.id,
              position.id,
              price,
              currentDate,
              exit.reason,
              exit.sellPct
            );
          }
        }

        portfolioState.snapshot(agent.id, currentDate);
      }

      clock.advance();
    }

    // Compare strategies
    const chatgptMetrics = portfolioState.getMetrics("chatgpt");
    const claudeMetrics = portfolioState.getMetrics("claude");
    const geminiMetrics = portfolioState.getMetrics("gemini");

    console.log("\n=== STRATEGY COMPARISON ===");
    console.log(
      `ChatGPT: ${chatgptMetrics.totalReturnPct.toFixed(2)}% return, ` +
        `${chatgptMetrics.totalTrades} trades, Sharpe: ${chatgptMetrics.sharpeRatio.toFixed(2)}`
    );
    console.log(
      `Claude: ${claudeMetrics.totalReturnPct.toFixed(2)}% return, ` +
        `${claudeMetrics.totalTrades} trades, Sharpe: ${claudeMetrics.sharpeRatio.toFixed(2)}`
    );
    console.log(
      `Gemini: ${geminiMetrics.totalReturnPct.toFixed(2)}% return, ` +
        `${geminiMetrics.totalTrades} trades, Sharpe: ${geminiMetrics.sharpeRatio.toFixed(2)}`
    );

    // All agents should have some return data
    expect(chatgptMetrics).toBeDefined();
    expect(claudeMetrics).toBeDefined();
    expect(geminiMetrics).toBeDefined();
  });
});
