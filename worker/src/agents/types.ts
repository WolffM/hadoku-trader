/**
 * Multi-Agent Trading Engine Type Definitions
 * Based on FINAL_ENGINE_SPEC.md
 */

// =============================================================================
// Scoring Configuration Types
// =============================================================================

export interface TimeDecayConfig {
  weight: number;
  half_life_days: number;
  use_filing_date?: boolean;
  filing_half_life_days?: number;
}

export interface PriceMovementConfig {
  weight: number;
  thresholds: {
    pct_0: number;   // Score at 0% price change
    pct_5: number;   // Score at 5% price change
    pct_15: number;  // Score at 15% price change
    pct_25: number;  // Score at 25% price change
  };
}

export interface PositionSizeConfig {
  weight: number;
  thresholds: number[];  // Dollar amounts: [15000, 50000, 100000, 250000]
  scores: number[];      // Corresponding scores: [0.2, 0.4, 0.6, 0.8, 1.0]
}

export interface PoliticianSkillConfig {
  weight: number;
  min_trades_for_data: number;
  default_score: number;
}

export interface SourceQualityConfig {
  weight: number;
  scores: Record<string, number>;  // source_name -> score
  confirmation_bonus: number;
  max_confirmation_bonus: number;
}

export interface FilingSpeedConfig {
  weight: number;
  fast_bonus: number;      // Applied when <= 7 days
  slow_penalty: number;    // Applied when >= 30 days
}

export interface CrossConfirmationConfig {
  weight: number;
  bonus_per_source: number;
  max_bonus: number;
}

export interface ScoringConfig {
  components: {
    time_decay?: TimeDecayConfig;
    price_movement?: PriceMovementConfig;
    position_size?: PositionSizeConfig;
    politician_skill?: PoliticianSkillConfig;
    source_quality?: SourceQualityConfig;
    filing_speed?: FilingSpeedConfig;
    cross_confirmation?: CrossConfirmationConfig;
  };
}

// =============================================================================
// Sizing Configuration Types
// =============================================================================

export type SizingMode = "score_squared" | "score_linear" | "equal_split";

export interface SizingConfig {
  mode: SizingMode;
  base_multiplier?: number;  // For score_squared: e.g., 0.20
  base_amount?: number;      // For score_linear: e.g., 200
  max_position_pct: number;
  max_position_amount: number;
  min_position_amount: number;
  max_open_positions: number;
  max_per_ticker: number;
}

// =============================================================================
// Exit Configuration Types
// =============================================================================

export type StopLossMode = "fixed" | "trailing";

export interface StopLossConfig {
  mode: StopLossMode;
  threshold_pct: number;
}

export interface TakeProfitConfig {
  first_threshold_pct: number;
  first_sell_pct: number;
  second_threshold_pct: number;
  second_sell_pct: number;
}

export interface SoftStopConfig {
  no_progress_days_stock: number;
  no_progress_days_option: number;
}

export interface ExitConfig {
  stop_loss: StopLossConfig;
  take_profit?: TakeProfitConfig;
  max_hold_days: number | null;
  soft_stop?: SoftStopConfig;
}

// =============================================================================
// Agent Configuration Types
// =============================================================================

export type AssetType = "stock" | "etf" | "option";

export interface AgentConfig {
  id: string;
  name: string;
  monthly_budget: number;

  // Filtering
  politician_whitelist: string[] | null;  // null = all politicians
  politician_scope_all?: boolean;          // Explicit flag for all politicians
  ticker_whitelist?: string[] | null;      // null = all tickers, otherwise limit to list
  allowed_asset_types: AssetType[];

  // Hard filters
  max_signal_age_days: number;
  max_price_move_pct: number;

  // Scoring (null = pass/fail only, like Gemini)
  scoring: ScoringConfig | null;

  // Decision thresholds
  execute_threshold: number;
  half_size_threshold: number | null;

  // Position sizing
  sizing: SizingConfig;

  // Exit rules
  exit: ExitConfig;
}

// =============================================================================
// Agent Database Types
// =============================================================================

export interface AgentRow {
  id: string;
  name: string;
  config_json: string;  // JSON stringified AgentConfig
  is_active: number;    // SQLite boolean (0 or 1)
  created_at: string;
  updated_at: string;
}

export interface AgentBudgetRow {
  id: string;
  agent_id: string;
  month: string;
  total_budget: number;
  spent: number;
  created_at: string;
}

export interface PoliticianStatsRow {
  name: string;
  total_trades: number;
  winning_trades: number;
  win_rate: number | null;
  avg_return_pct: number | null;
  last_updated: string | null;
}

export interface AgentPerformanceRow {
  id: string;
  agent_id: string;
  date: string;
  total_value: number;
  total_cost_basis: number;
  total_return_pct: number;
  spy_return_pct: number | null;
  positions_count: number;
  created_at: string;
}

// =============================================================================
// Signal Processing Types
// =============================================================================

export interface EnrichedSignal {
  id: string;
  ticker: string;
  action: "buy" | "sell";
  asset_type: AssetType;

  // Pricing
  trade_price: number;
  current_price: number;

  // Dates
  trade_date: string;
  disclosure_date: string;

  // Size
  position_size_min: number;

  // Attribution
  politician_name: string;
  source: string;

  // Computed fields (set by enrichment)
  days_since_trade: number;
  days_since_filing: number;  // Days since disclosure
  price_change_pct: number;
}

export type FilterReason =
  | "filter_politician"
  | "filter_ticker"
  | "filter_asset_type"
  | "filter_age"
  | "filter_price_move";

export type DecisionReason =
  | FilterReason
  | "skip_score"
  | "skip_budget"
  | "execute"
  | "execute_half";

export interface AgentDecision {
  agent_id: string;
  signal_id: string;
  action: "execute" | "execute_half" | "skip";
  decision_reason: DecisionReason;
  score: number | null;
  score_breakdown: Record<string, number> | null;
  position_size: number | null;
}

export interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
}

// =============================================================================
// Trade Action Types (Phase 5 - for hadoku-site integration)
// =============================================================================

/**
 * A trade action returned by analyzeSignals().
 * Contains all information needed for hadoku-site to execute the trade.
 */
export interface TradeAction {
  agent_id: string;
  agent_name: string;
  signal_id: string;
  ticker: string;
  action: "buy" | "sell";
  decision: "execute" | "execute_half" | "skip";
  quantity: number;        // Shares to trade
  position_size: number;   // Dollar amount
  current_price: number;
  score: number | null;
  score_breakdown: Record<string, number> | null;
  reasoning: string;
}

// =============================================================================
// API Response Types
// =============================================================================

export interface AgentSummary {
  id: string;
  name: string;
  is_active: boolean;
  monthly_budget: number;
  budget_spent: number;
  budget_remaining: number;
  positions_count: number;
  total_return_pct: number;
}

export interface AgentDetailResponse {
  agent: AgentSummary;
  config: AgentConfig;
  positions: AgentPosition[];
  recent_trades: AgentTrade[];
}

export interface AgentPosition {
  ticker: string;
  shares: number;
  entry_price: number;
  current_price: number;
  cost_basis: number;
  return_pct: number;
  days_held: number;
}

export interface AgentTrade {
  id: string;
  signal_id: string;
  ticker: string;
  action: string;
  decision: string;
  score: number | null;
  position_size: number | null;
  executed_at: string | null;
}

export interface AgentsListResponse {
  agents: AgentSummary[];
  last_updated: string;
}

export interface ProcessSignalsResponse {
  success: boolean;
  processed_count: number;
  results: Array<{
    signal_id: string;
    ticker: string;
    decisions: Array<{
      agent_id: string;
      action: string;
      reason: string;
    }>;
  }>;
}

// =============================================================================
// Position Types (Phase 3)
// =============================================================================

/**
 * Position row from database with all tracking fields.
 */
export interface PositionRow {
  id: string;
  agent_id: string;
  ticker: string;
  shares: number;
  entry_price: number;
  entry_date: string;
  cost_basis: number;
  highest_price: number; // For trailing stops
  asset_type: AssetType;
  status: "open" | "closed";
  signal_id: string | null;
  partial_sold: number; // SQLite boolean (0 or 1) for take-profit tracking
  closed_at: string | null;
  close_price: number | null;
  close_reason: CloseReason | null;
  created_at: string;
}

/**
 * Reasons for closing a position.
 */
export type CloseReason =
  | "stop_loss"
  | "take_profit"
  | "time_exit"
  | "soft_stop"
  | "sell_signal"
  | "manual";

// =============================================================================
// Execution Types (Phase 3)
// =============================================================================

/**
 * Result of executing a trade through Fidelity API.
 */
export interface ExecutionResult {
  success: boolean;
  trade_id: string;
  position_id: string | null;
  shares: number;
  executed_price: number;
  total: number;
  order_id: string | null;
  error: string | null;
}

/**
 * Details for updating a trade record after execution.
 */
export interface ExecutionDetails {
  quantity: number;
  price: number;
  total: number;
  status: "executed" | "failed";
  executed_at: string;
  error_message?: string;
}

/**
 * Request to Fidelity API for trade execution.
 */
export interface FidelityTradeRequest {
  ticker: string;
  quantity: number;
  action: "buy" | "sell";
  account?: string;
  dry_run?: boolean;
}

/**
 * Response from Fidelity API after trade execution.
 */
export interface FidelityTradeResponse {
  success: boolean;
  order_id?: string;
  error?: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// Monitoring Types (Phase 3)
// =============================================================================

/**
 * Exit decision returned by checkExitConditions.
 */
export interface ExitDecision {
  action: "close" | "partial";
  reason: CloseReason;
  sell_pct: number; // 100 for full close, less for partial
}

/**
 * Result of monitoring all positions.
 */
export interface MonitorResult {
  positions_checked: number;
  exits_triggered: number;
  exits: Array<{
    position_id: string;
    ticker: string;
    agent_id: string;
    reason: CloseReason;
    sell_pct: number;
  }>;
  highest_price_updates: number;
  errors: string[];
}

// =============================================================================
// Simulation Types (Phase 4)
// =============================================================================

/**
 * Position tracked during simulation.
 */
export interface SimPosition {
  id: string;
  ticker: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  currentPrice: number;
  highestPrice: number;
  partialSold: boolean;
  signalId: string;
  closePrice?: number;
  closeDate?: string;
  closeReason?: CloseReason;
}

/**
 * Daily snapshot of portfolio state.
 */
export interface DailySnapshot {
  date: string;
  totalValue: number;
  cash: number;
  positionsValue: number;
  returnPct: number;
  openPositions: number;
  closedToday: number;
}

/**
 * Per-agent portfolio state during simulation.
 */
export interface AgentPortfolio {
  agentId: string;
  cash: number;
  initialCash: number;
  positions: SimPosition[];
  closedPositions: SimPosition[];
  dailySnapshots: DailySnapshot[];
}

/**
 * Filter check result for verbose logging.
 */
export interface FilterCheck {
  check: string;
  passed: boolean;
  details: Record<string, unknown>;
}

/**
 * Score component breakdown for verbose logging.
 */
export interface ScoreBreakdown {
  time_decay?: number;
  price_movement?: number;
  position_size?: number;
  politician_skill?: number;
  source_quality?: number;
  filing_speed?: number;
  cross_confirmation?: number;
  weighted_total: number;
}

/**
 * Size calculation details for verbose logging.
 */
export interface SizeCalculation {
  mode: SizingMode;
  rawSize: number;
  constraints: {
    maxAmount: { limit: number; applied: boolean };
    maxPct: { limit: number; applied: boolean };
    budgetRemaining: { limit: number; applied: boolean };
    minimum: { limit: number; passed: boolean };
  };
  finalSize: number;
}

/**
 * Full reasoning chain for a decision.
 */
export interface ReasoningChain {
  filters: FilterCheck[];
  scoreComponents: ScoreBreakdown | null;
  sizeCalculation: SizeCalculation | null;
}

/**
 * Extended agent decision with full reasoning chain.
 */
export interface AgentDecisionWithReasoning extends AgentDecision {
  reasoning: ReasoningChain;
}

/**
 * Simulation event for logging.
 */
export type SimulationEventType =
  | "signal_received"
  | "decision_made"
  | "trade_executed"
  | "exit_triggered"
  | "daily_summary";

export interface SimulationEvent {
  timestamp: string;
  eventType: SimulationEventType;
  agentId?: string;
  data: Record<string, unknown>;
}

/**
 * Performance metrics for an agent.
 */
export interface PerformanceMetrics {
  // Returns
  totalReturnPct: number;
  annualizedReturnPct: number;

  // Risk
  maxDrawdownPct: number;
  volatility: number;
  sharpeRatio: number;

  // Activity
  totalTrades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  avgHoldDays: number;

  // Exits by reason
  exitReasons: {
    stop_loss: number;
    take_profit: number;
    time_exit: number;
    soft_stop: number;
  };
}

/**
 * Overall simulation report.
 */
export interface SimulationReport {
  startDate: string;
  endDate: string;
  totalDays: number;
  marketDays: number;
  signalsProcessed: number;
  signalsSkipped: number;
  agentResults: Record<string, PerformanceMetrics>;
}
