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
  portfolio_performance: PerformanceMetrics
  sp500_performance: PerformanceMetrics
  last_updated: string
}

export interface Position {
  ticker: string
  quantity: number
  avg_cost: number
  current_price: number
  market_value: number
  unrealized_pnl: number
  unrealized_pnl_pct: number
}

export interface PortfolioData {
  positions: Position[]
  cash: number
  total_value: number
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
