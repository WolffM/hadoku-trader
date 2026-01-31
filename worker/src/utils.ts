/**
 * Utility functions for the trader worker.
 */

import type { TraderEnv, Signal } from "./types";

/**
 * Create a JSON response with proper headers.
 */
export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/**
 * Verify API key from request headers.
 * Accepts: X-API-Key, Authorization: Bearer, or X-User-Key (for edge-router compatibility)
 */
export function verifyApiKey(
  request: Request,
  env: TraderEnv,
  keyName: "SCRAPER_API_KEY" | "TRADER_API_KEY"
): boolean {
  const apiKey =
    request.headers.get("X-API-Key") ||
    request.headers.get("X-User-Key") ||
    request.headers.get("Authorization")?.replace("Bearer ", "");
  return apiKey === env[keyName];
}

/**
 * Generate a unique ID with a prefix.
 */
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * CORS headers for cross-origin requests.
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-User-Key",
};

/**
 * Add CORS headers to a response.
 */
export function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

/**
 * Check if a signal already exists in the database by source + source_id.
 * Used for deduplication before inserting signals.
 */
export async function checkSignalExists(
  env: TraderEnv,
  source: string | null,
  sourceId: string | null
): Promise<{ id: string } | null> {
  const existing = await env.TRADER_DB.prepare(
    "SELECT id FROM signals WHERE source = ? AND source_id = ?"
  )
    .bind(source, sourceId)
    .first<{ id: string }>();

  return existing ?? null;
}

/**
 * Check if a logically duplicate signal exists (same ticker, politician, trade_date, action).
 * This catches duplicates that have different source_id values but represent the same trade.
 */
export async function checkLogicalDuplicate(
  env: TraderEnv,
  ticker: string | null | undefined,
  politicianName: string | null | undefined,
  tradeDate: string | null | undefined,
  action: string | null | undefined
): Promise<{ id: string } | null> {
  if (!ticker || !politicianName || !tradeDate || !action) {
    return null;
  }

  const existing = await env.TRADER_DB.prepare(`
    SELECT id FROM signals
    WHERE ticker = ? AND politician_name = ? AND trade_date = ? AND action = ?
    LIMIT 1
  `)
    .bind(ticker, politicianName, tradeDate, action)
    .first<{ id: string }>();

  return existing ?? null;
}

/**
 * Result of inserting a signal into the database.
 */
export interface InsertSignalResult {
  id: string;
  duplicate: boolean;
}

/**
 * Calculate disclosure lag in days between trade date and disclosure date.
 * Returns null if either date is missing.
 */
export function calculateDisclosureLagDays(
  tradeDate: string | null | undefined,
  disclosureDate: string | null | undefined
): number | null {
  if (!tradeDate || !disclosureDate) return null;
  const trade = new Date(tradeDate);
  const disclosure = new Date(disclosureDate);
  return Math.floor((disclosure.getTime() - trade.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Options for inserting a signal row.
 */
export interface InsertSignalRowOptions {
  /** Use lenient defaults for NOT NULL columns (for backfill data that may have missing fields) */
  lenient?: boolean;
}

/**
 * Insert a signal row directly into the database.
 * This is the low-level function used by both insertSignal and handleBackfillBatch.
 *
 * @param env - Environment with TRADER_DB binding
 * @param id - The signal ID to use
 * @param signal - Partial signal data (may have missing fields for backfill)
 * @param options - Insert options (lenient mode uses defaults for NOT NULL columns)
 */
export async function insertSignalRow(
  env: TraderEnv,
  id: string,
  signal: Partial<Signal> & { source?: string | null },
  options: InsertSignalRowOptions = {}
): Promise<void> {
  const lenient = options.lenient ?? false;

  // Calculate disclosure lag
  const disclosureLagDays = calculateDisclosureLagDays(
    signal.trade?.trade_date,
    signal.trade?.disclosure_date
  );

  // Helper: coalesce undefined/null to null, or use default in lenient mode
  const val = <T>(v: T | undefined | null, defaultVal?: T): T | null => {
    if (v !== undefined && v !== null) return v;
    if (lenient && defaultVal !== undefined) return defaultVal;
    return null;
  };

  await env.TRADER_DB.prepare(`
    INSERT INTO signals (
      id, source, politician_name, politician_chamber, politician_party, politician_state,
      ticker, action, asset_type, trade_price, disclosure_price, trade_date, disclosure_date,
      disclosure_lag_days, current_price, current_price_at,
      position_size, position_size_min, position_size_max,
      option_type, strike_price, expiration_date,
      source_url, source_id, scraped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      id,
      val(signal.source),
      val(signal.politician?.name),
      val(signal.politician?.chamber),
      val(signal.politician?.party, lenient ? "unknown" : undefined),       // NOT NULL
      val(signal.politician?.state, lenient ? "unknown" : undefined),       // NOT NULL
      val(signal.trade?.ticker),
      val(signal.trade?.action),
      val(signal.trade?.asset_type),
      val(signal.trade?.trade_price),
      val(signal.trade?.disclosure_price),
      val(signal.trade?.trade_date),
      val(signal.trade?.disclosure_date, lenient ? "" : undefined),         // NOT NULL
      disclosureLagDays,
      val(signal.trade?.current_price),
      val(signal.trade?.current_price_at),
      val(signal.trade?.position_size, lenient ? "" : undefined),           // NOT NULL
      val(signal.trade?.position_size_min, lenient ? 0 : undefined),        // NOT NULL
      val(signal.trade?.position_size_max, lenient ? 0 : undefined),        // NOT NULL
      val(signal.trade?.option_type),
      val(signal.trade?.strike_price),
      val(signal.trade?.expiration_date),
      val(signal.meta?.source_url, lenient ? "" : undefined),               // NOT NULL
      val(signal.meta?.source_id),
      val(signal.meta?.scraped_at)
    )
    .run();
}

/**
 * Insert a signal into the database, handling duplicates.
 * Returns the signal ID and whether it was a duplicate.
 *
 * Duplicate detection:
 * 1. By source + source_id (exact match from same source)
 * 2. By trade signature (ticker + politician + trade_date + action) to catch
 *    logically duplicate signals that may have different source_ids
 */
export async function insertSignal(
  env: TraderEnv,
  signal: Signal
): Promise<InsertSignalResult> {
  // Check for duplicate by source + source_id
  const existing = await checkSignalExists(env, signal.source, signal.meta.source_id);
  if (existing) {
    return { id: existing.id, duplicate: true };
  }

  // Check for logical duplicate (same trade signature)
  const logicalDupe = await checkLogicalDuplicate(
    env,
    signal.trade.ticker,
    signal.politician.name,
    signal.trade.trade_date,
    signal.trade.action
  );
  if (logicalDupe) {
    console.log(
      `Skipping logical duplicate: ${signal.trade.ticker} ${signal.trade.action} by ${signal.politician.name} on ${signal.trade.trade_date}`
    );
    return { id: logicalDupe.id, duplicate: true };
  }

  const id = generateId("sig");
  await insertSignalRow(env, id, signal, { lenient: false });

  return { id, duplicate: false };
}
