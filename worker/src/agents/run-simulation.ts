/**
 * Comprehensive Simulation Runner
 * Runs backtesting against real Capitol Trades data (3 years)
 *
 * Strategies tested:
 * 1. ChatGPT ("Decay Edge") - Score-squared sizing
 * 2. Claude ("Decay Alpha") - Score-linear sizing
 * 3. Gemini ("Titan Conviction") - Equal split, 5 Titans only
 * 4. Naive ("Monkey Trader") - Buys everything
 * 5. SPY Buy & Hold - Benchmark
 * 6. Smart ("Budget Aware") - Intelligent position sizing
 *
 * Run with: npx vitest run run-simulation.test.ts
 */

import type { AgentConfig, EnrichedSignal, SimPosition, CloseReason, ScoreBreakdown } from "./types";
import {
  CHATGPT_CONFIG,
  CLAUDE_CONFIG,
  GEMINI_CONFIG,
  NAIVE_CONFIG,
  SPY_BENCHMARK_CONFIG,
} from "./configs";

// =============================================================================
// Smart Sizing Agent - Intelligent Position Sizing
// =============================================================================

/**
 * Smart Agent: "Budget Aware"
 * - All politicians
 * - Same scoring as Claude (best balance)
 * - Intelligent sizing based on:
 *   1. Remaining budget percentage
 *   2. Capitol buy size (larger congressional buys = more trust)
 *   3. Cash reserves (keep 20% for upcoming opportunities)
 *   4. Signal quality score
 */
export const SMART_CONFIG: AgentConfig = {
  id: "smart",
  name: "Budget Aware",
  monthly_budget: 1000,

  politician_whitelist: null,
  allowed_asset_types: ["stock", "etf"],

  max_signal_age_days: 45,
  max_price_move_pct: 25,

  // Use Claude's scoring (best balance)
  scoring: {
    components: {
      time_decay: {
        weight: 0.25,
        half_life_days: 14,
        use_filing_date: true,
        filing_half_life_days: 3,
      },
      price_movement: {
        weight: 0.30,
        thresholds: {
          pct_0: 1.2,
          pct_5: 0.8,
          pct_15: 0.4,
          pct_25: 0.2,
        },
      },
      position_size: {
        weight: 0.25, // Higher weight for congressional buy size
        thresholds: [15000, 50000, 100000, 250000],
        scores: [0.3, 0.5, 0.7, 0.85, 1.0],
      },
      politician_skill: {
        weight: 0.1,
        min_trades_for_data: 20,
        default_score: 0.5,
      },
      source_quality: {
        weight: 0.1,
        scores: {
          quiver_quant: 1.0,
          capitol_trades: 0.9,
          unusual_whales: 0.85,
          house_stock_watcher: 0.8,
          senate_stock_watcher: 0.8,
          default: 0.8,
        },
        confirmation_bonus: 0.05,
        max_confirmation_bonus: 0.15,
      },
    },
  },

  execute_threshold: 0.55,
  half_size_threshold: null,

  sizing: {
    mode: "smart_budget",
    base_amount: 20,                 // $20 base, adjusted by capitol size and score
    max_position_pct: 0.03,          // Max 3% of budget = $30 per position
    max_position_amount: 30,         // $30 max allows ~33 trades/month
    min_position_amount: 5,
    max_open_positions: 9999,
    max_per_ticker: 9999,
    reserve_pct: 0.10,               // Keep 10% cash reserve
    capitol_size_multiplier: true,   // Use congressional buy size in sizing
  },

  exit: {
    stop_loss: {
      mode: "fixed",
      threshold_pct: 15,
    },
    take_profit: {
      first_threshold_pct: 20,
      first_sell_pct: 40,
      second_threshold_pct: 35,
      second_sell_pct: 100,
    },
    max_hold_days: 90,
  },
};

// =============================================================================
// Smart Position Sizing
// =============================================================================

/**
 * Position size bucket based on congressional trade size.
 * Larger congressional buys suggest higher conviction.
 */
export function getCapitolSizeBucket(positionSizeMin: number): {
  bucket: string;
  multiplier: number;
} {
  if (positionSizeMin >= 500000) return { bucket: "mega", multiplier: 1.5 };
  if (positionSizeMin >= 250000) return { bucket: "very_large", multiplier: 1.3 };
  if (positionSizeMin >= 100000) return { bucket: "large", multiplier: 1.15 };
  if (positionSizeMin >= 50000) return { bucket: "medium", multiplier: 1.0 };
  if (positionSizeMin >= 15000) return { bucket: "small", multiplier: 0.85 };
  return { bucket: "tiny", multiplier: 0.7 };
}

/**
 * Calculate smart position size considering:
 * 1. Score (signal quality)
 * 2. Remaining budget (don't over-deploy)
 * 3. Capitol buy size (trust larger buys more)
 * 4. Reserve requirement (keep cash for opportunities)
 * 5. Current deployment ratio (avoid concentration)
 */
export function calculateSmartPositionSize(
  agent: AgentConfig,
  score: number | null,
  budget: { remaining: number; total: number },
  signal: { position_size_min: number },
  openPositionCount: number
): number {
  const sizing = agent.sizing;

  // Base calculation from score
  const effectiveScore = score ?? 0.6;
  let baseSize = (sizing.base_amount ?? 200) * effectiveScore;

  // 1. Capitol buy size multiplier
  if (sizing.capitol_size_multiplier) {
    const { multiplier } = getCapitolSizeBucket(signal.position_size_min);
    baseSize *= multiplier;
  }

  // 2. Budget deployment adjustment
  // If we've already deployed a lot, be more conservative
  const deployedRatio = 1 - (budget.remaining / budget.total);
  if (deployedRatio > 0.7) {
    // More than 70% deployed - scale down
    baseSize *= 0.7;
  } else if (deployedRatio > 0.5) {
    // 50-70% deployed - slight scale down
    baseSize *= 0.85;
  }

  // 3. Reserve requirement
  const reserveAmount = budget.total * (sizing.reserve_pct ?? 0.20);
  const availableForTrade = Math.max(0, budget.remaining - reserveAmount);

  // 4. Don't bet more than available (minus reserve)
  let size = Math.min(baseSize, availableForTrade);

  // 5. Apply standard constraints
  size = Math.min(size, sizing.max_position_amount);
  size = Math.min(size, agent.monthly_budget * sizing.max_position_pct);

  // 6. Check minimum
  if (size < sizing.min_position_amount) {
    return 0;
  }

  return Math.round(size * 100) / 100;
}

// =============================================================================
// All Simulation Agents
// =============================================================================

export const ALL_SIM_AGENTS = [
  CHATGPT_CONFIG,
  CLAUDE_CONFIG,
  GEMINI_CONFIG,
  NAIVE_CONFIG,
  SMART_CONFIG,
];

// =============================================================================
// Simulation Statistics
// =============================================================================

export interface DetailedStats {
  agentId: string;
  agentName: string;

  // Return metrics
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;

  // Trade metrics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;

  // Position metrics
  avgPositionSize: number;
  avgHoldDays: number;
  maxHoldDays: number;
  minHoldDays: number;

  // Exit analysis
  exitReasons: Record<string, number>;

  // Capital efficiency
  avgCashUtilization: number;
  maxDrawdownDays: number;

  // Risk metrics
  volatility: number;
  calmarRatio: number;

  // Comparison
  alphaVsSpy: number | null;
  betaVsSpy: number | null;
}

export interface SimulationSummary {
  period: {
    startDate: string;
    endDate: string;
    totalDays: number;
    marketDays: number;
    totalSignals: number;
  };
  spyBuyHold: {
    startPrice: number | null;
    endPrice: number | null;
    returnPct: number | null;
  };
  strategies: DetailedStats[];
  rankings: {
    byReturn: string[];
    bySharpe: string[];
    byWinRate: string[];
    byRiskAdjusted: string[];
  };
}

/**
 * Calculate detailed statistics for an agent's performance.
 */
export function calculateDetailedStats(
  agentId: string,
  agentName: string,
  closedPositions: SimPosition[],
  dailySnapshots: Array<{ date: string; totalValue: number; returnPct: number }>,
  totalDays: number,
  spyReturn: number | null
): DetailedStats {
  // Trade analysis
  const wins = closedPositions.filter(p => {
    const ret = (p.closePrice! - p.entryPrice) / p.entryPrice;
    return ret > 0;
  });
  const losses = closedPositions.filter(p => {
    const ret = (p.closePrice! - p.entryPrice) / p.entryPrice;
    return ret <= 0;
  });

  const winReturns = wins.map(p => ((p.closePrice! - p.entryPrice) / p.entryPrice) * 100);
  const lossReturns = losses.map(p => ((p.closePrice! - p.entryPrice) / p.entryPrice) * 100);

  const avgWinPct = winReturns.length > 0
    ? winReturns.reduce((a, b) => a + b, 0) / winReturns.length
    : 0;
  const avgLossPct = lossReturns.length > 0
    ? lossReturns.reduce((a, b) => a + b, 0) / lossReturns.length
    : 0;

  const totalWins = winReturns.reduce((a, b) => a + b, 0);
  const totalLosses = Math.abs(lossReturns.reduce((a, b) => a + b, 0));
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

  // Hold time analysis
  const holdDays = closedPositions.map(p => {
    const start = new Date(p.entryDate);
    const end = new Date(p.closeDate!);
    return Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  });
  const avgHoldDays = holdDays.length > 0 ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length : 0;
  const maxHoldDays = holdDays.length > 0 ? Math.max(...holdDays) : 0;
  const minHoldDays = holdDays.length > 0 ? Math.min(...holdDays) : 0;

  // Position size analysis
  const positionSizes = closedPositions.map(p => p.shares * p.entryPrice);
  const avgPositionSize = positionSizes.length > 0
    ? positionSizes.reduce((a, b) => a + b, 0) / positionSizes.length
    : 0;

  // Exit reason analysis
  const exitReasons: Record<string, number> = {
    stop_loss: 0,
    take_profit: 0,
    time_exit: 0,
    soft_stop: 0,
  };
  for (const p of closedPositions) {
    if (p.closeReason && exitReasons[p.closeReason] !== undefined) {
      exitReasons[p.closeReason]++;
    }
  }

  // Return calculations
  const finalReturn = dailySnapshots.length > 0
    ? dailySnapshots[dailySnapshots.length - 1].returnPct
    : 0;
  const years = totalDays / 365;
  const annualizedReturn = years > 0
    ? (Math.pow(1 + finalReturn / 100, 1 / years) - 1) * 100
    : finalReturn;

  // Volatility (daily returns std dev, annualized)
  const dailyReturns: number[] = [];
  for (let i = 1; i < dailySnapshots.length; i++) {
    const prevValue = dailySnapshots[i - 1].totalValue;
    const currValue = dailySnapshots[i].totalValue;
    if (prevValue > 0) {
      dailyReturns.push((currValue - prevValue) / prevValue);
    }
  }

  const avgDailyReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    : 0;
  const variance = dailyReturns.length > 0
    ? dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDailyReturn, 2), 0) / dailyReturns.length
    : 0;
  const dailyVolatility = Math.sqrt(variance);
  const annualizedVolatility = dailyVolatility * Math.sqrt(252) * 100;

  // Sharpe Ratio (assuming 5% risk-free rate)
  const riskFreeRate = 5;
  const excessReturn = annualizedReturn - riskFreeRate;
  const sharpeRatio = annualizedVolatility > 0 ? excessReturn / annualizedVolatility : 0;

  // Sortino Ratio (only downside volatility)
  const negativeReturns = dailyReturns.filter(r => r < 0);
  const downsideVariance = negativeReturns.length > 0
    ? negativeReturns.reduce((sum, r) => sum + r * r, 0) / negativeReturns.length
    : 0;
  const downsideVolatility = Math.sqrt(downsideVariance) * Math.sqrt(252) * 100;
  const sortinoRatio = downsideVolatility > 0 ? excessReturn / downsideVolatility : 0;

  // Max Drawdown
  let maxDrawdown = 0;
  let peak = dailySnapshots[0]?.totalValue ?? 0;
  let maxDrawdownDays = 0;
  let currentDrawdownStart = 0;

  for (let i = 0; i < dailySnapshots.length; i++) {
    const value = dailySnapshots[i].totalValue;
    if (value > peak) {
      peak = value;
      currentDrawdownStart = i;
    }
    const drawdown = (peak - value) / peak * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownDays = i - currentDrawdownStart;
    }
  }

  // Calmar Ratio
  const calmarRatio = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

  // Alpha vs SPY (simple calculation)
  const alphaVsSpy = spyReturn !== null ? finalReturn - spyReturn : null;

  return {
    agentId,
    agentName,
    totalReturnPct: Math.round(finalReturn * 100) / 100,
    annualizedReturnPct: Math.round(annualizedReturn * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    sortinoRatio: Math.round(sortinoRatio * 100) / 100,
    totalTrades: closedPositions.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: closedPositions.length > 0 ? Math.round(wins.length / closedPositions.length * 10000) / 100 : 0,
    avgWinPct: Math.round(avgWinPct * 100) / 100,
    avgLossPct: Math.round(avgLossPct * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    avgPositionSize: Math.round(avgPositionSize * 100) / 100,
    avgHoldDays: Math.round(avgHoldDays * 10) / 10,
    maxHoldDays,
    minHoldDays,
    exitReasons,
    avgCashUtilization: 0, // Would need to track this during simulation
    maxDrawdownDays,
    volatility: Math.round(annualizedVolatility * 100) / 100,
    calmarRatio: Math.round(calmarRatio * 100) / 100,
    alphaVsSpy: alphaVsSpy !== null ? Math.round(alphaVsSpy * 100) / 100 : null,
    betaVsSpy: null, // Would need SPY daily returns to calculate
  };
}

/**
 * Print a comprehensive simulation report.
 */
export function printSimulationReport(summary: SimulationSummary): void {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                    CONGRESSIONAL TRADE SIMULATION REPORT                       ║");
  console.log("╚════════════════════════════════════════════════════════════════════════════════╝");

  // Period info
  console.log("\n┌─ SIMULATION PERIOD ─────────────────────────────────────────────────────────────┐");
  console.log(`│  Start Date: ${summary.period.startDate}`);
  console.log(`│  End Date:   ${summary.period.endDate}`);
  console.log(`│  Duration:   ${summary.period.totalDays} days (${summary.period.marketDays} market days)`);
  console.log(`│  Signals:    ${summary.period.totalSignals} total`);
  console.log("└──────────────────────────────────────────────────────────────────────────────────┘");

  // SPY Benchmark
  console.log("\n┌─ SPY BUY & HOLD BENCHMARK ──────────────────────────────────────────────────────┐");
  if (summary.spyBuyHold.returnPct !== null) {
    const spyRet = summary.spyBuyHold.returnPct;
    console.log(`│  Start Price: $${summary.spyBuyHold.startPrice?.toFixed(2)}`);
    console.log(`│  End Price:   $${summary.spyBuyHold.endPrice?.toFixed(2)}`);
    console.log(`│  Return:      ${spyRet >= 0 ? "+" : ""}${spyRet.toFixed(2)}%`);
  } else {
    console.log("│  (No SPY price data available)");
  }
  console.log("└──────────────────────────────────────────────────────────────────────────────────┘");

  // Strategy comparison table
  console.log("\n┌─ STRATEGY COMPARISON ───────────────────────────────────────────────────────────┐");
  console.log("│                                                                                  │");
  console.log("│  Strategy         Return    Sharpe   Win Rate   Trades   Avg Hold   Max DD     │");
  console.log("│  ──────────────────────────────────────────────────────────────────────────────  │");

  for (const s of summary.strategies) {
    const ret = (s.totalReturnPct >= 0 ? "+" : "") + s.totalReturnPct.toFixed(1) + "%";
    const sharpe = s.sharpeRatio.toFixed(2);
    const winRate = s.winRate.toFixed(0) + "%";
    const trades = s.totalTrades.toString();
    const holdDays = s.avgHoldDays.toFixed(0) + "d";
    const maxDD = "-" + s.maxDrawdownPct.toFixed(1) + "%";

    const name = s.agentName.padEnd(16);
    const retStr = ret.padStart(8);
    const sharpeStr = sharpe.padStart(7);
    const winStr = winRate.padStart(9);
    const tradesStr = trades.padStart(8);
    const holdStr = holdDays.padStart(10);
    const ddStr = maxDD.padStart(9);

    console.log(`│  ${name}${retStr} ${sharpeStr} ${winStr} ${tradesStr} ${holdStr} ${ddStr}     │`);
  }
  console.log("│                                                                                  │");
  console.log("└──────────────────────────────────────────────────────────────────────────────────┘");

  // Detailed strategy breakdowns
  for (const s of summary.strategies) {
    console.log(`\n┌─ ${s.agentName.toUpperCase()} (${s.agentId}) ─────────────────────────────────────────────────────┐`);
    console.log("│");
    console.log("│  RETURNS");
    console.log(`│    Total Return:      ${s.totalReturnPct >= 0 ? "+" : ""}${s.totalReturnPct.toFixed(2)}%`);
    console.log(`│    Annualized:        ${s.annualizedReturnPct >= 0 ? "+" : ""}${s.annualizedReturnPct.toFixed(2)}%`);
    console.log(`│    Alpha vs SPY:      ${s.alphaVsSpy !== null ? (s.alphaVsSpy >= 0 ? "+" : "") + s.alphaVsSpy.toFixed(2) + "%" : "N/A"}`);
    console.log("│");
    console.log("│  RISK METRICS");
    console.log(`│    Max Drawdown:      -${s.maxDrawdownPct.toFixed(2)}% (${s.maxDrawdownDays} days)`);
    console.log(`│    Volatility:        ${s.volatility.toFixed(2)}% (annualized)`);
    console.log(`│    Sharpe Ratio:      ${s.sharpeRatio.toFixed(2)}`);
    console.log(`│    Sortino Ratio:     ${s.sortinoRatio.toFixed(2)}`);
    console.log(`│    Calmar Ratio:      ${s.calmarRatio.toFixed(2)}`);
    console.log("│");
    console.log("│  TRADE ANALYSIS");
    console.log(`│    Total Trades:      ${s.totalTrades}`);
    console.log(`│    Winning:           ${s.winningTrades} (${s.winRate.toFixed(1)}%)`);
    console.log(`│    Losing:            ${s.losingTrades}`);
    console.log(`│    Avg Win:           +${s.avgWinPct.toFixed(2)}%`);
    console.log(`│    Avg Loss:          ${s.avgLossPct.toFixed(2)}%`);
    console.log(`│    Profit Factor:     ${s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)}`);
    console.log("│");
    console.log("│  POSITION STATS");
    console.log(`│    Avg Position Size: $${s.avgPositionSize.toFixed(2)}`);
    console.log(`│    Avg Hold Time:     ${s.avgHoldDays.toFixed(1)} days`);
    console.log(`│    Min/Max Hold:      ${s.minHoldDays}-${s.maxHoldDays} days`);
    console.log("│");
    console.log("│  EXIT REASONS");
    console.log(`│    Stop Loss:         ${s.exitReasons.stop_loss}`);
    console.log(`│    Take Profit:       ${s.exitReasons.take_profit}`);
    console.log(`│    Time Exit:         ${s.exitReasons.time_exit}`);
    console.log(`│    Soft Stop:         ${s.exitReasons.soft_stop}`);
    console.log("│");
    console.log("└──────────────────────────────────────────────────────────────────────────────────┘");
  }

  // Rankings
  console.log("\n┌─ STRATEGY RANKINGS ─────────────────────────────────────────────────────────────┐");
  console.log("│");
  console.log("│  By Total Return:     " + summary.rankings.byReturn.join(" > "));
  console.log("│  By Sharpe Ratio:     " + summary.rankings.bySharpe.join(" > "));
  console.log("│  By Win Rate:         " + summary.rankings.byWinRate.join(" > "));
  console.log("│  By Risk-Adjusted:    " + summary.rankings.byRiskAdjusted.join(" > "));
  console.log("│");
  console.log("└──────────────────────────────────────────────────────────────────────────────────┘");

  // Key insights
  console.log("\n┌─ KEY INSIGHTS ──────────────────────────────────────────────────────────────────┐");
  console.log("│");

  const best = summary.strategies.reduce((a, b) => a.totalReturnPct > b.totalReturnPct ? a : b);
  const worst = summary.strategies.reduce((a, b) => a.totalReturnPct < b.totalReturnPct ? a : b);
  const mostTrades = summary.strategies.reduce((a, b) => a.totalTrades > b.totalTrades ? a : b);
  const bestSharpe = summary.strategies.reduce((a, b) => a.sharpeRatio > b.sharpeRatio ? a : b);

  console.log(`│  🏆 Best Performer:    ${best.agentName} (${best.totalReturnPct >= 0 ? "+" : ""}${best.totalReturnPct.toFixed(2)}%)`);
  console.log(`│  📉 Worst Performer:   ${worst.agentName} (${worst.totalReturnPct >= 0 ? "+" : ""}${worst.totalReturnPct.toFixed(2)}%)`);
  console.log(`│  📊 Most Active:       ${mostTrades.agentName} (${mostTrades.totalTrades} trades)`);
  console.log(`│  ⚖️  Best Risk/Reward:  ${bestSharpe.agentName} (Sharpe: ${bestSharpe.sharpeRatio.toFixed(2)})`);

  if (summary.spyBuyHold.returnPct !== null) {
    const beatSpy = summary.strategies.filter(s => s.totalReturnPct > summary.spyBuyHold.returnPct!);
    if (beatSpy.length > 0) {
      console.log(`│  🎯 Beat SPY:          ${beatSpy.map(s => s.agentName).join(", ")}`);
    } else {
      console.log("│  🎯 Beat SPY:          None - all strategies underperformed SPY");
    }
  }

  console.log("│");
  console.log("└──────────────────────────────────────────────────────────────────────────────────┘");
  console.log("\n");
}
