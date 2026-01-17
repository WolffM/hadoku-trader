// API Types for hadoku-trader dashboard
// These match the schema defined in docs/apiRequirements.md

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
  disclosed_price: number | null
  disclosed_date: string
  filing_date: string
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
  hadoku_performance: PerformanceMetrics // Our executed trades performance
  sp500_performance: PerformanceMetrics
  last_updated: string
}

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

export interface SourcePerformance {
  name: string
  total_signals: number
  executed_signals: number
  avg_return_pct: number
  win_rate: number
}

// API Response types
export interface SignalsResponse {
  signals: Signal[]
  last_updated: string
}

export interface TradesResponse {
  trades: ExecutedTrade[]
  last_updated: string
}

export interface SourcesResponse {
  sources: SourcePerformance[]
  last_updated: string
}

// Trade Execution types
export interface ExecuteTradeRequest {
  ticker: string
  action: 'buy' | 'sell'
  quantity: number
  account?: string
  dry_run?: boolean
}

export interface ExecuteTradeResponse {
  success: boolean
  message: string
  order_id?: string
  details?: Record<string, unknown>
}

// Health check
export interface HealthResponse {
  status: 'healthy' | 'degraded'
  database: 'connected' | 'disconnected'
  trader_worker: 'connected' | 'disconnected'
  timestamp: string
}

// Agent types
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

export interface AgentsResponse {
  agents: AgentSummary[]
  last_updated: string
}

// API base URL (configure based on environment)
export const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/trader'
