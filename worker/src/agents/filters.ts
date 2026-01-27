/**
 * Agent filtering and validation utilities
 */

import type {
  AgentConfig,
  EnrichedSignal,
  AssetType,
  FilterReason,
} from "./types";

// =============================================================================
// Signal Filtering
// =============================================================================

/**
 * Check if an agent should process a given signal based on hard filters.
 * Returns passes: true if signal passes all filters, false otherwise with reason.
 */
export function shouldAgentProcessSignal(
  agent: AgentConfig,
  signal: EnrichedSignal
): { passes: boolean; reason: FilterReason | "passed" } {
  // 1. Check politician whitelist
  if (agent.politician_whitelist !== null) {
    const normalizedWhitelist = agent.politician_whitelist.map((name) =>
      name.toLowerCase().trim()
    );
    const normalizedPolitician = signal.politician_name.toLowerCase().trim();
    if (!normalizedWhitelist.includes(normalizedPolitician)) {
      return { passes: false, reason: "filter_politician" };
    }
  }

  // 2. Check ticker whitelist (for benchmark agents like SPY)
  if (agent.ticker_whitelist && agent.ticker_whitelist.length > 0) {
    const normalizedWhitelist = agent.ticker_whitelist.map((t) =>
      t.toUpperCase().trim()
    );
    const normalizedTicker = signal.ticker.toUpperCase().trim();
    if (!normalizedWhitelist.includes(normalizedTicker)) {
      return { passes: false, reason: "filter_ticker" };
    }
  }

  // 3. Check asset type
  if (!agent.allowed_asset_types.includes(signal.asset_type as AssetType)) {
    return { passes: false, reason: "filter_asset_type" };
  }

  // 4. Check signal age (days since trade)
  if (signal.days_since_trade > agent.max_signal_age_days) {
    return { passes: false, reason: "filter_age" };
  }

  // 5. Check price movement (absolute value)
  if (Math.abs(signal.price_change_pct) > agent.max_price_move_pct) {
    return { passes: false, reason: "filter_price_move" };
  }

  return { passes: true, reason: "passed" };
}

// =============================================================================
// Date Utilities
// =============================================================================

/**
 * Calculate days between two ISO date strings (YYYY-MM-DD or full ISO8601).
 * Returns absolute value (always positive).
 */
export function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Get current date as YYYY-MM-DD string.
 */
export function getCurrentDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Get current month in YYYY-MM format for budget tracking.
 */
export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Add days to an ISO date string, return new YYYY-MM-DD.
 */
export function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}

// =============================================================================
// Price Utilities
// =============================================================================

/**
 * Calculate price change percentage.
 * Returns percentage value (e.g., 5 for 5% increase).
 */
export function calculatePriceChangePct(
  disclosedPrice: number,
  currentPrice: number
): number {
  if (disclosedPrice <= 0) return 0;
  return ((currentPrice - disclosedPrice) / disclosedPrice) * 100;
}

// =============================================================================
// Signal Enrichment
// =============================================================================

/**
 * Raw signal row from database.
 */
export interface RawSignalRow {
  id: string;
  ticker: string;
  action: "buy" | "sell";
  asset_type: string;
  trade_price: number | null;
  trade_date: string;
  disclosure_date: string;
  position_size_min: number;
  politician_name: string;
  source: string;
}

/**
 * Enrich a raw signal with computed fields.
 * @param evaluationDate - Optional date to evaluate from (defaults to today for production, use disclosure_date for simulation)
 */
export function enrichSignal(
  rawSignal: RawSignalRow,
  currentPrice: number,
  evaluationDate?: string
): EnrichedSignal {
  const evalDate = evaluationDate ?? getCurrentDate();
  const tradePrice = rawSignal.trade_price ?? currentPrice;
  const priceChangePct = calculatePriceChangePct(tradePrice, currentPrice);

  // Debug logging for price change calculation
  console.log(`[ENRICH] Signal ${rawSignal.id}:`);
  console.log(`[ENRICH]   Raw trade_price: ${rawSignal.trade_price} (type: ${typeof rawSignal.trade_price})`);
  console.log(`[ENRICH]   Used trade_price: $${tradePrice.toFixed(2)}`);
  console.log(`[ENRICH]   Current price: $${currentPrice.toFixed(2)}`);
  console.log(`[ENRICH]   Price change: ${priceChangePct.toFixed(2)}%`);

  return {
    id: rawSignal.id,
    ticker: rawSignal.ticker,
    action: rawSignal.action,
    asset_type: rawSignal.asset_type as AssetType,
    trade_price: tradePrice,
    current_price: currentPrice,
    trade_date: rawSignal.trade_date,
    disclosure_date: rawSignal.disclosure_date,
    position_size_min: rawSignal.position_size_min,
    politician_name: rawSignal.politician_name,
    source: rawSignal.source,
    days_since_trade: daysBetween(rawSignal.trade_date, evalDate),
    days_since_filing: daysBetween(rawSignal.disclosure_date, evalDate),
    price_change_pct: priceChangePct,
  };
}

// =============================================================================
// Math Utilities
// =============================================================================

/**
 * Linear interpolation between two values.
 * @param a Start value
 * @param b End value
 * @param t Progress (0 to 1)
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round to specified decimal places.
 */
export function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// =============================================================================
// ID Generation
// =============================================================================

/**
 * Generate a unique ID with prefix.
 * Format: prefix_timestamp_random
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}
