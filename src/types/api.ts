// API Types for hadoku-trader dashboard
//
// These types are derived from the worker package types to maintain consistency.
// The worker package (worker/src/types.ts) is the source of truth.

// =============================================================================
// Signal Types (from worker/src/types.ts)
// =============================================================================

export interface Politician {
  name: string
  chamber: 'house' | 'senate'
  party: 'D' | 'R' | 'I'
  state: string
}

export interface Trade {
  ticker: string
  action: 'buy' | 'sell'
  asset_type: 'stock' | 'option' | 'etf' | 'bond' | 'crypto'
  trade_date: string
  trade_price: number | null
  disclosure_date: string
  disclosure_price: number | null
  position_size: string
  position_size_min: number
  position_size_max: number
}

export interface SignalMeta {
  source_url: string
  source_id: string
  scraped_at: string
}

export interface Signal {
  id: string
  source:
    | 'unusual_whales'
    | 'capitol_trades'
    | 'quiver_quant'
    | 'house_stock_watcher'
    | 'senate_stock_watcher'
  politician: Politician
  trade: Trade
  meta: SignalMeta
}

// =============================================================================
// Performance Types (from worker/src/types.ts)
// =============================================================================

export interface PerformanceHistory {
  date: string
  value: number
}

export interface PerformanceMetrics {
  total_return_pct: number
  mtd_return_pct: number
  ytd_return_pct: number
  history: PerformanceHistory[]
}

export interface PerformanceData {
  signals_performance: PerformanceMetrics
  hadoku_performance: PerformanceMetrics
  sp500_performance: PerformanceMetrics
  last_updated: string
}

// =============================================================================
// Trade Types (from worker/src/types.ts)
// =============================================================================

export interface TradeReasoning {
  politician: string
  source_count: number
  conviction_multiplier: number
  priced_in_factor: number
  position_size_tier: string
}

export interface ExecutedTrade {
  id: string
  date: string
  ticker: string
  action: 'buy' | 'sell'
  quantity: number
  price: number
  total: number
  signal_id: string
  reasoning: TradeReasoning
  status: 'executed' | 'pending' | 'skipped'
}

// =============================================================================
// Source Types (from worker/src/types.ts)
// =============================================================================

export interface SourcePerformance {
  name: string
  total_signals: number
  executed_signals: number
  avg_return_pct: number
  win_rate: number
}

// =============================================================================
// Agent Types (from worker/src/agents/types.ts)
// =============================================================================

export interface AgentSummary {
  id: string
  name: string
  is_active: boolean
  monthly_budget: number
  budget_spent: number
  budget_remaining: number
  positions_count: number
  total_return_pct: number
}

export interface AgentPosition {
  ticker: string
  shares: number
  entry_price: number
  current_price: number
  cost_basis: number
  return_pct: number
  days_held: number
}

export interface AgentDetail {
  agent: AgentSummary
  positions: AgentPosition[]
}

// =============================================================================
// API Configuration
// =============================================================================

export const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/trader'
