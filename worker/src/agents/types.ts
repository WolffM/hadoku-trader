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
  disclosed_price: number;
  current_price: number;

  // Dates
  trade_date: string;
  filing_date: string;

  // Size
  position_size_min: number;

  // Attribution
  politician_name: string;
  source: string;

  // Computed fields (set by enrichment)
  days_since_trade: number;
  days_since_filing: number;
  price_change_pct: number;
}

export type FilterReason =
  | "filter_politician"
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
