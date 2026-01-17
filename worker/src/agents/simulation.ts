/**
 * Simulation Framework for Backtesting Trading Strategies
 * Phase 4: Strategy validation through historical replay
 */

import type {
  AgentPortfolio,
  DailySnapshot,
  SimPosition,
  SimulationEvent,
  SimulationEventType,
  SimulationReport,
  PerformanceMetrics,
  CloseReason,
  ScoreBreakdown,
  AgentDecision,
} from "./types";
import { calculateMetrics } from "./metrics";

// =============================================================================
// SimulationClock - Controls simulation time
// =============================================================================

export class SimulationClock {
  private currentDate: string;
  private startDate: string;
  private endDate: string;

  constructor(startDate: string, endDate: string) {
    this.startDate = startDate;
    this.endDate = endDate;
    this.currentDate = startDate;
  }

  getDate(): string {
    return this.currentDate;
  }

  getStartDate(): string {
    return this.startDate;
  }

  getEndDate(): string {
    return this.endDate;
  }

  advance(days: number = 1): void {
    // Parse date components directly to avoid timezone issues
    const [year, month, dayOfMonth] = this.currentDate.split("-").map(Number);
    const d = new Date(year, month - 1, dayOfMonth);
    d.setDate(d.getDate() + days);
    this.currentDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  isMarketDay(): boolean {
    // Parse date components directly to avoid timezone issues
    const [year, month, dayOfMonth] = this.currentDate.split("-").map(Number);
    const d = new Date(year, month - 1, dayOfMonth);
    const dayOfWeek = d.getDay();
    return dayOfWeek !== 0 && dayOfWeek !== 6; // Skip weekends
  }

  isComplete(): boolean {
    return this.currentDate > this.endDate;
  }

  reset(): void {
    this.currentDate = this.startDate;
  }

  /**
   * Get number of market days in the simulation period.
   */
  getMarketDaysCount(): number {
    let count = 0;
    const d = new Date(this.startDate);
    const end = new Date(this.endDate);

    while (d <= end) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) {
        count++;
      }
      d.setDate(d.getDate() + 1);
    }

    return count;
  }
}

// =============================================================================
// SignalReplayer - Feeds signals chronologically
// =============================================================================

export interface SignalForSim {
  id: string;
  ticker: string;
  action: "buy" | "sell";
  asset_type: "stock" | "etf" | "option";
  disclosed_price: number;
  disclosed_date: string;
  filing_date: string;
  position_size_min: number;
  politician_name: string;
  source: string;
}

export class SignalReplayer {
  private signals: SignalForSim[];
  private processedIds: Set<string> = new Set();

  constructor(signals: SignalForSim[]) {
    // Sort by disclosed_date ascending
    this.signals = [...signals].sort((a, b) =>
      a.disclosed_date.localeCompare(b.disclosed_date)
    );
  }

  /**
   * Get signals that should be visible on this date.
   * Only returns signals that haven't been processed yet.
   */
  getSignalsForDate(date: string): SignalForSim[] {
    return this.signals.filter(
      (s) => s.disclosed_date <= date && !this.processedIds.has(s.id)
    );
  }

  /**
   * Mark a signal as processed so it won't be returned again.
   */
  markProcessed(signalId: string): void {
    this.processedIds.add(signalId);
  }

  /**
   * Get count of signals available on a specific date.
   */
  getSignalCountForDate(date: string): number {
    return this.signals.filter(
      (s) => s.disclosed_date <= date && !this.processedIds.has(s.id)
    ).length;
  }

  /**
   * Reset for a new simulation run.
   */
  reset(): void {
    this.processedIds.clear();
  }

  /**
   * Get total signal count.
   */
  getTotalCount(): number {
    return this.signals.length;
  }
}

// =============================================================================
// PortfolioState - Tracks positions and cash per agent
// =============================================================================

export class PortfolioState {
  private portfolios: Map<string, AgentPortfolio> = new Map();

  /**
   * Initialize portfolios for a list of agents with starting budget.
   */
  initialize(agentIds: string[], budget: number): void {
    for (const id of agentIds) {
      this.portfolios.set(id, {
        agentId: id,
        cash: budget,
        initialCash: budget,
        positions: [],
        closedPositions: [],
        dailySnapshots: [],
      });
    }
  }

  /**
   * Get portfolio for an agent.
   */
  getPortfolio(agentId: string): AgentPortfolio {
    const portfolio = this.portfolios.get(agentId);
    if (!portfolio) {
      throw new Error(`Portfolio not found for agent: ${agentId}`);
    }
    return portfolio;
  }

  /**
   * Get all portfolios.
   */
  getAllPortfolios(): Map<string, AgentPortfolio> {
    return this.portfolios;
  }

  /**
   * Get current cash for an agent.
   */
  getCash(agentId: string): number {
    return this.getPortfolio(agentId).cash;
  }

  /**
   * Add a new position to an agent's portfolio.
   */
  addPosition(agentId: string, position: SimPosition): void {
    const portfolio = this.getPortfolio(agentId);
    const cost = position.shares * position.entryPrice;

    portfolio.positions.push(position);
    portfolio.cash -= cost;
  }

  /**
   * Close a position and move to closed list.
   */
  closePosition(
    agentId: string,
    positionId: string,
    closePrice: number,
    closeDate: string,
    reason: CloseReason,
    sellPct: number = 100
  ): SimPosition | null {
    const portfolio = this.getPortfolio(agentId);
    const positionIndex = portfolio.positions.findIndex(
      (p) => p.id === positionId
    );

    if (positionIndex === -1) {
      return null;
    }

    const position = portfolio.positions[positionIndex];

    if (sellPct === 100) {
      // Full close
      position.closePrice = closePrice;
      position.closeDate = closeDate;
      position.closeReason = reason;

      // Add proceeds to cash
      portfolio.cash += position.shares * closePrice;

      // Move to closed positions
      portfolio.closedPositions.push(position);
      portfolio.positions.splice(positionIndex, 1);

      return position;
    } else {
      // Partial close
      const sharesToSell = Math.floor(position.shares * (sellPct / 100));
      const proceeds = sharesToSell * closePrice;

      // Create closed position record
      const closedPortion: SimPosition = {
        ...position,
        id: `${position.id}_partial`,
        shares: sharesToSell,
        closePrice,
        closeDate,
        closeReason: reason,
      };

      // Update remaining position
      position.shares -= sharesToSell;
      position.partialSold = true;

      // Add proceeds to cash
      portfolio.cash += proceeds;

      // Add closed portion to closed list
      portfolio.closedPositions.push(closedPortion);

      return closedPortion;
    }
  }

  /**
   * Update current prices for all positions.
   */
  updatePrices(agentId: string, prices: Map<string, number>): void {
    const portfolio = this.getPortfolio(agentId);

    for (const position of portfolio.positions) {
      const price = prices.get(position.ticker);
      if (price !== undefined) {
        position.currentPrice = price;
        if (price > position.highestPrice) {
          position.highestPrice = price;
        }
      }
    }
  }

  /**
   * Take a daily snapshot of the portfolio.
   */
  snapshot(agentId: string, date: string): void {
    const portfolio = this.getPortfolio(agentId);

    const positionsValue = portfolio.positions.reduce(
      (sum, p) => sum + p.shares * p.currentPrice,
      0
    );

    const totalValue = portfolio.cash + positionsValue;
    const returnPct =
      ((totalValue - portfolio.initialCash) / portfolio.initialCash) * 100;

    // Count positions closed today
    const closedToday = portfolio.closedPositions.filter(
      (p) => p.closeDate === date
    ).length;

    const snapshot: DailySnapshot = {
      date,
      totalValue,
      cash: portfolio.cash,
      positionsValue,
      returnPct,
      openPositions: portfolio.positions.length,
      closedToday,
    };

    portfolio.dailySnapshots.push(snapshot);
  }

  /**
   * Get performance metrics for an agent.
   */
  getMetrics(agentId: string): PerformanceMetrics {
    const portfolio = this.getPortfolio(agentId);
    return calculateMetrics(portfolio);
  }

  /**
   * Add monthly budget allocation (additive, not reset).
   * Agents keep their existing cash plus get new monthly allocation.
   */
  addMonthlyBudget(agentId: string, additionalBudget: number): void {
    const portfolio = this.getPortfolio(agentId);
    portfolio.cash += additionalBudget;
    // Track total capital allocated for return calculations
    portfolio.initialCash += additionalBudget;
  }

  /**
   * Check if it's a new month compared to last check.
   */
  isNewMonth(currentDate: string, lastDate: string): boolean {
    const current = new Date(currentDate);
    const last = new Date(lastDate);
    return (
      current.getFullYear() > last.getFullYear() ||
      current.getMonth() > last.getMonth()
    );
  }

  /**
   * Reset all portfolios for a new run.
   */
  reset(budget: number): void {
    for (const [agentId, portfolio] of this.portfolios) {
      portfolio.cash = budget;
      portfolio.initialCash = budget;
      portfolio.positions = [];
      portfolio.closedPositions = [];
      portfolio.dailySnapshots = [];
    }
  }
}

// =============================================================================
// EventLogger - Records all simulation events
// =============================================================================

export class EventLogger {
  private events: SimulationEvent[] = [];
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  /**
   * Log when a signal is received.
   */
  logSignalReceived(date: string, signal: SignalForSim): void {
    this.events.push({
      timestamp: date,
      eventType: "signal_received",
      data: {
        signalId: signal.id,
        ticker: signal.ticker,
        action: signal.action,
        politician: signal.politician_name,
        source: signal.source,
        disclosedPrice: signal.disclosed_price,
        positionSize: signal.position_size_min,
      },
    });

    if (this.verbose) {
      console.log(
        `[${date}] SIGNAL: ${signal.ticker} ${signal.action} by ${signal.politician_name} ($${signal.position_size_min.toLocaleString()})`
      );
    }
  }

  /**
   * Log an agent's decision on a signal.
   */
  logDecision(
    date: string,
    agentId: string,
    signal: SignalForSim,
    decision: AgentDecision,
    scoreBreakdown?: ScoreBreakdown
  ): void {
    this.events.push({
      timestamp: date,
      eventType: "decision_made",
      agentId,
      data: {
        signalId: signal.id,
        ticker: signal.ticker,
        action: signal.action,
        decision: decision.action,
        reason: decision.decision_reason,
        score: decision.score,
        scoreBreakdown,
        positionSize: decision.position_size,
      },
    });

    if (this.verbose) {
      const scoreStr = decision.score ? ` (score=${decision.score.toFixed(2)})` : "";
      const sizeStr = decision.position_size
        ? ` → $${decision.position_size.toFixed(2)}`
        : "";
      console.log(
        `  → ${agentId.toUpperCase()}: ${decision.action.toUpperCase()}${scoreStr}${sizeStr}`
      );

      if (scoreBreakdown && decision.action !== "skip") {
        for (const [key, value] of Object.entries(scoreBreakdown)) {
          if (key !== "weighted_total" && value !== undefined) {
            console.log(`      ${key}: ${(value as number).toFixed(2)}`);
          }
        }
      }
    }
  }

  /**
   * Log a trade execution.
   */
  logTradeExecuted(
    date: string,
    agentId: string,
    position: SimPosition
  ): void {
    this.events.push({
      timestamp: date,
      eventType: "trade_executed",
      agentId,
      data: {
        positionId: position.id,
        ticker: position.ticker,
        shares: position.shares,
        entryPrice: position.entryPrice,
        total: position.shares * position.entryPrice,
      },
    });
  }

  /**
   * Log an exit triggered.
   */
  logExit(
    date: string,
    agentId: string,
    position: SimPosition,
    reason: CloseReason
  ): void {
    const pnl =
      ((position.closePrice! - position.entryPrice) / position.entryPrice) *
      100;

    this.events.push({
      timestamp: date,
      eventType: "exit_triggered",
      agentId,
      data: {
        positionId: position.id,
        ticker: position.ticker,
        shares: position.shares,
        entryPrice: position.entryPrice,
        closePrice: position.closePrice,
        reason,
        pnlPct: pnl,
        holdDays: daysBetween(position.entryDate, date),
      },
    });

    if (this.verbose) {
      const pnlStr = pnl >= 0 ? `+${pnl.toFixed(1)}%` : `${pnl.toFixed(1)}%`;
      console.log(
        `  → ${agentId.toUpperCase()} EXIT: ${position.ticker} @ ${reason} (${pnlStr})`
      );
    }
  }

  /**
   * Log daily summary.
   */
  logDailySummary(
    date: string,
    portfolios: Map<string, AgentPortfolio>
  ): void {
    const summaryData: Record<string, unknown> = { date };

    for (const [agentId, portfolio] of portfolios) {
      const snapshot = portfolio.dailySnapshots[portfolio.dailySnapshots.length - 1];
      if (snapshot) {
        summaryData[agentId] = {
          totalValue: snapshot.totalValue,
          returnPct: snapshot.returnPct,
          positions: snapshot.openPositions,
          closedToday: snapshot.closedToday,
        };
      }
    }

    this.events.push({
      timestamp: date,
      eventType: "daily_summary",
      data: summaryData,
    });
  }

  /**
   * Get all events.
   */
  getEvents(): SimulationEvent[] {
    return this.events;
  }

  /**
   * Get events for a specific agent.
   */
  getAgentEvents(agentId: string): SimulationEvent[] {
    return this.events.filter((e) => e.agentId === agentId);
  }

  /**
   * Get events by type.
   */
  getEventsByType(type: SimulationEventType): SimulationEvent[] {
    return this.events.filter((e) => e.eventType === type);
  }

  /**
   * Generate simulation report.
   */
  getReport(
    clock: SimulationClock,
    portfolioState: PortfolioState
  ): SimulationReport {
    const signalEvents = this.getEventsByType("signal_received");
    const decisionEvents = this.getEventsByType("decision_made");

    const skippedCount = decisionEvents.filter(
      (e) => e.data.decision === "skip"
    ).length;

    const agentResults: Record<string, PerformanceMetrics> = {};
    for (const [agentId] of portfolioState.getAllPortfolios()) {
      agentResults[agentId] = portfolioState.getMetrics(agentId);
    }

    return {
      startDate: clock.getStartDate(),
      endDate: clock.getEndDate(),
      totalDays: daysBetween(clock.getStartDate(), clock.getEndDate()) + 1,
      marketDays: clock.getMarketDaysCount(),
      signalsProcessed: signalEvents.length,
      signalsSkipped: skippedCount,
      agentResults,
    };
  }

  /**
   * Reset for new run.
   */
  reset(): void {
    this.events = [];
  }

  /**
   * Print summary report to console.
   */
  printReport(report: SimulationReport): void {
    console.log("\n" + "=".repeat(60));
    console.log(
      `SIMULATION REPORT: ${report.startDate} → ${report.endDate}`
    );
    console.log("=".repeat(60));
    console.log(`\nTotal Days: ${report.totalDays}`);
    console.log(`Market Days: ${report.marketDays}`);
    console.log(`Signals Processed: ${report.signalsProcessed}`);

    for (const [agentId, metrics] of Object.entries(report.agentResults)) {
      console.log(`\n--- ${agentId.toUpperCase()} ---`);
      console.log(`Total Return: ${metrics.totalReturnPct >= 0 ? "+" : ""}${metrics.totalReturnPct.toFixed(2)}%`);
      console.log(`Max Drawdown: ${metrics.maxDrawdownPct.toFixed(2)}%`);
      console.log(`Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}`);
      console.log(
        `Trades: ${metrics.totalTrades} (Win Rate: ${metrics.winRate.toFixed(1)}%)`
      );
      console.log(`Avg Hold: ${metrics.avgHoldDays.toFixed(0)} days`);
      console.log(
        `Exits: stop_loss=${metrics.exitReasons.stop_loss}, ` +
          `take_profit=${metrics.exitReasons.take_profit}, ` +
          `time_exit=${metrics.exitReasons.time_exit}, ` +
          `soft_stop=${metrics.exitReasons.soft_stop}`
      );
    }

    console.log("\n" + "=".repeat(60));
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculate days between two dates.
 */
export function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diff = end.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Add days to a date string.
 */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

/**
 * Generate a unique ID for simulation.
 */
export function generateSimId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
