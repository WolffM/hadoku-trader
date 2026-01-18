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

/**
 * Required environment bindings for the trader worker.
 * Extend this in hadoku-site with your additional bindings.
 */
export interface TraderEnv {
  // D1 Database for trader data
  TRADER_DB: D1Database;

  // Secrets
  SCRAPER_API_KEY: string;
  TRADER_API_KEY: string;
  TUNNEL_URL: string; // cloudflared tunnel to local fidelity service
  SCRAPER_URL: string; // hadoku-scraper API URL for market data
}

// Legacy alias for backwards compatibility
export type Env = TraderEnv;

// =============================================================================
// Signal Types (from hadoku-scraper)
// =============================================================================

export interface Politician {
  name: string;
  chamber: string;  // "house", "senate", or other (extensible)
  party: string;    // "D", "R", "I", or other (extensible)
  state: string;
}

export interface Trade {
  ticker: string;
  action: string;   // "buy", "sell", "exchange", etc. (extensible)
  asset_type: string; // "stock", "option", "etf", "bond", "crypto", etc. (extensible)

  // Trade timing & price (when politician traded)
  trade_date: string;           // YYYY-MM-DD - when the trade was executed
  trade_price: number | null;   // Price at time of trade

  // Disclosure timing & price (when public learned)
  disclosure_date: string;           // YYYY-MM-DD - when filing became public
  disclosure_price: number | null;   // Price when disclosed
  disclosure_lag_days?: number;      // Computed: disclosure_date - trade_date

  // Current price (for portfolio valuation)
  current_price?: number | null;
  current_price_at?: string | null;  // ISO8601 timestamp

  position_size: string;
  position_size_min: number;
  position_size_max: number;

  // Option-specific fields
  option_type: "call" | "put" | null;
  strike_price: number | null;
  expiration_date: string | null; // YYYY-MM-DD
}

export interface SignalMeta {
  source_url: string;
  source_id: string;
  scraped_at: string; // ISO8601
}

/**
 * Known signal sources (for documentation).
 * The API accepts ANY string as source - add new sources freely without code changes.
 */
export type KnownSignalSource =
  | "unusual_whales"
  | "capitol_trades"
  | "quiver_quant"
  | "house_stock_watcher"
  | "senate_stock_watcher"
  | "sec_form4"
  | "finviz_insider";

/**
 * Signal source - accepts any string for extensibility.
 * Use KnownSignalSource values for consistency, but any identifier works.
 */
export type SignalSource = string;

export interface Signal {
  id?: string;
  source: SignalSource;
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
  hadoku_performance: PerformanceMetrics; // Our executed trades performance
  sp500_performance: PerformanceMetrics;
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
  action: string;
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
  action: string;
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
// Health Types
// =============================================================================

export interface HealthResponse {
  status: "healthy" | "degraded";
  database: "connected" | "disconnected";
  trader_worker: "connected" | "disconnected";
  timestamp: string;
}

// =============================================================================
// API Response Wrapper
// =============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SignalPostResponse {
  success: boolean;
  message: string;
  id?: string;
  duplicate?: boolean;
}

export interface SignalsResponse {
  signals: Signal[];
  last_updated: string;
}

// =============================================================================
// Market Data Types (from hadoku-scraper)
// =============================================================================

export interface MarketQuote {
  ticker: string;
  price: number;
  change_pct: number;
  timestamp: string;
}

export interface ScraperDataPackage {
  signals: Signal[];
  market_data: {
    sp500: MarketQuote;
    quotes: MarketQuote[]; // Current prices for tickers in signals
  };
  last_updated: string;
}
