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
 * Check if a signal already exists in the database.
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
 * Result of inserting a signal into the database.
 */
export interface InsertSignalResult {
  id: string;
  duplicate: boolean;
}

/**
 * Insert a signal into the database, handling duplicates.
 * Returns the signal ID and whether it was a duplicate.
 */
export async function insertSignal(
  env: TraderEnv,
  signal: Signal
): Promise<InsertSignalResult> {
  // Check for duplicate using shared function
  const existing = await checkSignalExists(env, signal.source, signal.meta.source_id);

  if (existing) {
    return { id: existing.id, duplicate: true };
  }

  const id = generateId("sig");

  // Calculate disclosure lag in days
  const tradeDate = new Date(signal.trade.trade_date);
  const disclosureDate = new Date(signal.trade.disclosure_date);
  const disclosureLagDays = Math.floor(
    (disclosureDate.getTime() - tradeDate.getTime()) / (1000 * 60 * 60 * 24)
  );

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
      signal.source,
      signal.politician.name,
      signal.politician.chamber,
      signal.politician.party,
      signal.politician.state,
      signal.trade.ticker,
      signal.trade.action,
      signal.trade.asset_type,
      signal.trade.trade_price,
      signal.trade.disclosure_price,
      signal.trade.trade_date,
      signal.trade.disclosure_date,
      disclosureLagDays,
      signal.trade.current_price ?? null,
      signal.trade.current_price_at ?? null,
      signal.trade.position_size,
      signal.trade.position_size_min,
      signal.trade.position_size_max,
      signal.trade.option_type,
      signal.trade.strike_price,
      signal.trade.expiration_date,
      signal.meta.source_url,
      signal.meta.source_id,
      signal.meta.scraped_at
    )
    .run();

  return { id, duplicate: false };
}
