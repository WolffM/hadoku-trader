/**
 * Utility functions for the trader worker.
 */

import { TraderEnv } from "./types";

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
