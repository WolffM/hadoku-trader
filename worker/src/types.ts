/**
 * Type definitions for the Hadoku Trader Worker API.
 *
 * These types are shared between:
 * - Cloudflare Worker (this file)
 * - Dashboard frontend (src/types/api.ts)
 * - hadoku-scraper (for signal posting)
 */

// =============================================================================
// Environment Bindings
// =============================================================================

export interface Env {
  // D1 Database
  DB: D1Database;

  // Secrets
  SCRAPER_API_KEY: string;
  TRADER_API_KEY: string;
  TUNNEL_URL: string; // cloudflared tunnel to local trader-worker
}

// =============================================================================
// Signal Types (from hadoku-scraper)
// =============================================================================

export interface Politician {
  name: string;
  chamber: "house" | "senate";
  party: "D" | "R" | "I";
  state: string;
}

export interface Trade {
  ticker: string;
  action: "buy" | "sell";
  asset_type: "stock" | "option" | "etf" | "bond" | "crypto";
  disclosed_price: number | null;
  disclosed_date: string; // YYYY-MM-DD
  filing_date: string; // YYYY-MM-DD
  position_size: string;
  position_size_min: number;
  position_size_max: number;
}

export interface SignalMeta {
  source_url: string;
  source_id: string;
  scraped_at: string; // ISO8601
}

export interface Signal {
  id?: string;
  source:
    | "unusual_whales"
    | "capitol_trades"
    | "quiver_quant"
    | "house_stock_watcher"
    | "senate_stock_watcher";
  politician: Politician;
  trade: Trade;
  meta: SignalMeta;
}

// =============================================================================
// Performance Types
// =============================================================================

export interface PerformancePoint {
  date: string;
  value: number;
}

export interface PerformanceMetrics {
  total_return_pct: number;
  mtd_return_pct: number;
  ytd_return_pct: number;
  history: PerformancePoint[];
}

export interface PerformanceResponse {
  signals_performance: PerformanceMetrics;
  portfolio_performance: PerformanceMetrics;
  sp500_performance: PerformanceMetrics;
  last_updated: string;
}

// =============================================================================
// Portfolio Types
// =============================================================================

export interface Position {
  ticker: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
}

export interface PortfolioResponse {
  positions: Position[];
  cash: number;
  total_value: number;
  last_updated: string;
}

// =============================================================================
// Trade Types
// =============================================================================

export interface TradeReasoning {
  politician: string;
  source_count: number;
  conviction_multiplier: number;
  priced_in_factor: number;
  position_size_tier: string;
}

export interface ExecutedTrade {
  id: string;
  date: string;
  ticker: string;
  action: "buy" | "sell";
  quantity: number;
  price: number;
  total: number;
  signal_id: string | null;
  reasoning: TradeReasoning | null;
  status: "executed" | "pending" | "skipped" | "failed";
}

export interface TradesResponse {
  trades: ExecutedTrade[];
  last_updated: string;
}

// =============================================================================
// Source Types
// =============================================================================

export interface SourceStats {
  name: string;
  total_signals: number;
  executed_signals: number;
  avg_return_pct: number;
  win_rate: number;
}

export interface SourcesResponse {
  sources: SourceStats[];
  last_updated: string;
}

// =============================================================================
// Trade Execution Types
// =============================================================================

export interface ExecuteTradeRequest {
  ticker: string;
  action: "buy" | "sell";
  quantity: number;
  account?: string;
  dry_run?: boolean;
}

export interface ExecuteTradeResponse {
  success: boolean;
  message: string;
  order_id?: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// API Response Wrapper
// =============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
