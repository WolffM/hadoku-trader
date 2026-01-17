/**
 * Performance Metrics Calculations
 * Calculates returns, risk metrics, and trading statistics
 */

import type { AgentPortfolio, PerformanceMetrics, CloseReason } from "./types";
import { daysBetween } from "./simulation";

// =============================================================================
// Main Metrics Calculation
// =============================================================================

/**
 * Calculate comprehensive performance metrics from a portfolio.
 */
export function calculateMetrics(portfolio: AgentPortfolio): PerformanceMetrics {
  const closedPositions = portfolio.closedPositions;
  const snapshots = portfolio.dailySnapshots;

  // Calculate returns
  const { totalReturnPct, annualizedReturnPct } = calculateReturns(portfolio);

  // Calculate risk metrics
  const { maxDrawdownPct, volatility, sharpeRatio } = calculateRiskMetrics(
    snapshots,
    totalReturnPct
  );

  // Calculate trade statistics
  const {
    totalTrades,
    winRate,
    avgWinPct,
    avgLossPct,
    avgHoldDays,
  } = calculateTradeStats(closedPositions);

  // Count exits by reason
  const exitReasons = countExitReasons(closedPositions);

  return {
    totalReturnPct,
    annualizedReturnPct,
    maxDrawdownPct,
    volatility,
    sharpeRatio,
    totalTrades,
    winRate,
    avgWinPct,
    avgLossPct,
    avgHoldDays,
    exitReasons,
  };
}

// =============================================================================
// Return Calculations
// =============================================================================

/**
 * Calculate total and annualized returns.
 */
function calculateReturns(portfolio: AgentPortfolio): {
  totalReturnPct: number;
  annualizedReturnPct: number;
} {
  const snapshots = portfolio.dailySnapshots;

  if (snapshots.length === 0) {
    return { totalReturnPct: 0, annualizedReturnPct: 0 };
  }

  const lastSnapshot = snapshots[snapshots.length - 1];
  const totalReturnPct = lastSnapshot.returnPct;

  // Annualize based on trading days
  const tradingDays = snapshots.length;
  const yearsTraded = tradingDays / 252; // ~252 trading days per year

  let annualizedReturnPct = 0;
  if (yearsTraded > 0 && totalReturnPct > -100) {
    // Compound annual growth rate
    const totalReturn = 1 + totalReturnPct / 100;
    annualizedReturnPct =
      (Math.pow(totalReturn, 1 / yearsTraded) - 1) * 100;
  }

  return { totalReturnPct, annualizedReturnPct };
}

// =============================================================================
// Risk Metrics Calculations
// =============================================================================

interface RiskMetrics {
  maxDrawdownPct: number;
  volatility: number;
  sharpeRatio: number;
}

/**
 * Calculate risk metrics from daily snapshots.
 */
function calculateRiskMetrics(
  snapshots: AgentPortfolio["dailySnapshots"],
  totalReturnPct: number
): RiskMetrics {
  if (snapshots.length < 2) {
    return { maxDrawdownPct: 0, volatility: 0, sharpeRatio: 0 };
  }

  // Calculate daily returns
  const dailyReturns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prevValue = snapshots[i - 1].totalValue;
    const currValue = snapshots[i].totalValue;
    if (prevValue > 0) {
      dailyReturns.push((currValue - prevValue) / prevValue);
    }
  }

  // Max Drawdown
  const maxDrawdownPct = calculateMaxDrawdown(snapshots);

  // Volatility (standard deviation of daily returns, annualized)
  const volatility = calculateVolatility(dailyReturns);

  // Sharpe Ratio (assuming 5% risk-free rate)
  const riskFreeRate = 0.05;
  const annualizedReturn = totalReturnPct / 100;
  const excessReturn = annualizedReturn - riskFreeRate;
  const sharpeRatio = volatility > 0 ? excessReturn / volatility : 0;

  return { maxDrawdownPct, volatility, sharpeRatio };
}

/**
 * Calculate maximum drawdown from peak.
 */
function calculateMaxDrawdown(
  snapshots: AgentPortfolio["dailySnapshots"]
): number {
  if (snapshots.length === 0) {
    return 0;
  }

  let peak = snapshots[0].totalValue;
  let maxDrawdown = 0;

  for (const snapshot of snapshots) {
    if (snapshot.totalValue > peak) {
      peak = snapshot.totalValue;
    }

    const drawdown = (peak - snapshot.totalValue) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown * 100;
}

/**
 * Calculate annualized volatility from daily returns.
 */
function calculateVolatility(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) {
    return 0;
  }

  // Calculate mean
  const mean =
    dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;

  // Calculate variance
  const squaredDiffs = dailyReturns.map((r) => Math.pow(r - mean, 2));
  const variance =
    squaredDiffs.reduce((sum, d) => sum + d, 0) / (dailyReturns.length - 1);

  // Standard deviation
  const dailyStdDev = Math.sqrt(variance);

  // Annualize (multiply by sqrt of trading days)
  return dailyStdDev * Math.sqrt(252);
}

// =============================================================================
// Trade Statistics
// =============================================================================

interface TradeStats {
  totalTrades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  avgHoldDays: number;
}

/**
 * Calculate trade statistics from closed positions.
 */
function calculateTradeStats(
  closedPositions: AgentPortfolio["closedPositions"]
): TradeStats {
  const trades = closedPositions.filter((p) => p.closePrice !== undefined);
  const totalTrades = trades.length;

  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      avgHoldDays: 0,
    };
  }

  // Calculate return for each trade
  const tradeReturns = trades.map((trade) => ({
    returnPct:
      ((trade.closePrice! - trade.entryPrice) / trade.entryPrice) * 100,
    holdDays: trade.closeDate
      ? daysBetween(trade.entryDate, trade.closeDate)
      : 0,
  }));

  // Winners and losers
  const winners = tradeReturns.filter((t) => t.returnPct > 0);
  const losers = tradeReturns.filter((t) => t.returnPct <= 0);

  const winRate = (winners.length / totalTrades) * 100;

  const avgWinPct =
    winners.length > 0
      ? winners.reduce((sum, t) => sum + t.returnPct, 0) / winners.length
      : 0;

  const avgLossPct =
    losers.length > 0
      ? losers.reduce((sum, t) => sum + t.returnPct, 0) / losers.length
      : 0;

  const avgHoldDays =
    tradeReturns.reduce((sum, t) => sum + t.holdDays, 0) / totalTrades;

  return {
    totalTrades,
    winRate,
    avgWinPct,
    avgLossPct,
    avgHoldDays,
  };
}

// =============================================================================
// Exit Reason Counting
// =============================================================================

/**
 * Count exits by reason.
 */
function countExitReasons(
  closedPositions: AgentPortfolio["closedPositions"]
): PerformanceMetrics["exitReasons"] {
  const counts = {
    stop_loss: 0,
    take_profit: 0,
    time_exit: 0,
    soft_stop: 0,
  };

  for (const position of closedPositions) {
    const reason = position.closeReason;
    if (reason && reason in counts) {
      counts[reason as keyof typeof counts]++;
    }
  }

  return counts;
}

// =============================================================================
// Comparison Utilities
// =============================================================================

/**
 * Compare two agents' performance.
 */
export function compareAgents(
  metrics1: PerformanceMetrics,
  metrics2: PerformanceMetrics
): {
  returnDiff: number;
  sharpeRatioDiff: number;
  winner: 1 | 2 | 0;
} {
  const returnDiff = metrics1.totalReturnPct - metrics2.totalReturnPct;
  const sharpeRatioDiff = metrics1.sharpeRatio - metrics2.sharpeRatio;

  // Winner determined by Sharpe ratio (risk-adjusted return)
  let winner: 1 | 2 | 0 = 0;
  if (sharpeRatioDiff > 0.1) {
    winner = 1;
  } else if (sharpeRatioDiff < -0.1) {
    winner = 2;
  }

  return { returnDiff, sharpeRatioDiff, winner };
}

/**
 * Calculate information ratio (alpha / tracking error).
 */
export function calculateInformationRatio(
  agentReturns: number[],
  benchmarkReturns: number[]
): number {
  if (
    agentReturns.length !== benchmarkReturns.length ||
    agentReturns.length < 2
  ) {
    return 0;
  }

  // Calculate active returns (agent - benchmark)
  const activeReturns = agentReturns.map((r, i) => r - benchmarkReturns[i]);

  // Mean active return
  const meanActive =
    activeReturns.reduce((sum, r) => sum + r, 0) / activeReturns.length;

  // Tracking error (std dev of active returns)
  const squaredDiffs = activeReturns.map((r) => Math.pow(r - meanActive, 2));
  const trackingError = Math.sqrt(
    squaredDiffs.reduce((sum, d) => sum + d, 0) / (activeReturns.length - 1)
  );

  // Information ratio
  return trackingError > 0 ? (meanActive * 252) / (trackingError * Math.sqrt(252)) : 0;
}

/**
 * Calculate Sortino ratio (uses downside deviation instead of total volatility).
 */
export function calculateSortinoRatio(
  dailyReturns: number[],
  targetReturn: number = 0
): number {
  if (dailyReturns.length < 2) {
    return 0;
  }

  // Mean return
  const meanReturn =
    dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;

  // Downside deviation (only negative returns)
  const downsideReturns = dailyReturns.filter((r) => r < targetReturn);
  if (downsideReturns.length === 0) {
    return Infinity; // No downside - perfect
  }

  const downsideSquared = downsideReturns.map((r) =>
    Math.pow(r - targetReturn, 2)
  );
  const downsideDeviation = Math.sqrt(
    downsideSquared.reduce((sum, d) => sum + d, 0) / downsideReturns.length
  );

  // Annualize
  const annualizedReturn = meanReturn * 252;
  const annualizedDownsideDeviation = downsideDeviation * Math.sqrt(252);

  return annualizedDownsideDeviation > 0
    ? annualizedReturn / annualizedDownsideDeviation
    : 0;
}
