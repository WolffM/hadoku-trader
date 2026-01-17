/**
 * Main request handler factory for the trader worker.
 *
 * Creates a request handler that can be mounted in hadoku-site.
 */

import { TraderEnv } from "./types";
import {
  handleGetSignals,
  handlePostSignal,
  handleBackfillBatch,
  handleGetPerformance,
  handleGetTrades,
  handleGetSources,
  handleExecuteTrade,
  handleHealth,
  handleGetAgents,
  handleGetAgentById,
  handleProcessSignals,
  handleMarketPricesBackfill,
  handleGetMarketPrices,
  handleGetMarketTickers,
  handleMarketBackfillTrigger,
  handleRunSimulation,
} from "./routes";
import { jsonResponse, corsHeaders, withCors } from "./utils";

export interface TraderHandlerOptions {
  /** Base path for routes (default: '/api/trader') */
  basePath?: string;
}

/**
 * Creates a request handler for trader routes.
 *
 * Usage:
 * ```typescript
 * const handler = createTraderHandler(env);
 * return handler(request);
 * ```
 *
 * Or with custom base path:
 * ```typescript
 * const handler = createTraderHandler(env, { basePath: '/trader' });
 * ```
 */
export function createTraderHandler(
  env: TraderEnv,
  options: TraderHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const basePath = options.basePath ?? "/api/trader";

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Remove base path to get route
    const route = path.startsWith(basePath)
      ? path.slice(basePath.length) || "/"
      : path;

    try {
      let response: Response;

      // Route matching
      switch (true) {
        case route === "/signals" && request.method === "GET":
          response = await handleGetSignals(env);
          break;

        case route === "/signals" && request.method === "POST":
          response = await handlePostSignal(request, env);
          break;

        case route === "/signals/backfill" && request.method === "POST":
          response = await handleBackfillBatch(request, env);
          break;

        case route === "/performance" && request.method === "GET":
          response = await handleGetPerformance(env);
          break;

        case route === "/trades" && request.method === "GET":
          response = await handleGetTrades(env);
          break;

        case route === "/sources" && request.method === "GET":
          response = await handleGetSources(env);
          break;

        case route === "/execute" && request.method === "POST":
          response = await handleExecuteTrade(request, env);
          break;

        case route === "/health" && request.method === "GET":
          response = await handleHealth(env);
          break;

        // Agent routes
        case route === "/agents" && request.method === "GET":
          response = await handleGetAgents(env);
          break;

        case /^\/agents\/[^/]+$/.test(route) && request.method === "GET": {
          const agentId = route.split("/")[2];
          response = await handleGetAgentById(env, agentId);
          break;
        }

        case route === "/signals/process" && request.method === "POST":
          response = await handleProcessSignals(request, env);
          break;

        // Market prices routes
        case route === "/market/backfill" && request.method === "POST":
          response = await handleMarketPricesBackfill(request, env);
          break;

        case route === "/market/prices" && request.method === "GET":
          response = await handleGetMarketPrices(request, env);
          break;

        case route === "/market/tickers" && request.method === "GET":
          response = await handleGetMarketTickers(env);
          break;

        case route === "/market/backfill/trigger" && request.method === "POST":
          response = await handleMarketBackfillTrigger(request, env);
          break;

        case route === "/simulation/run" && request.method === "POST":
          response = await handleRunSimulation(request, env);
          break;

        default:
          response = jsonResponse({ success: false, error: "Not found" }, 404);
      }

      return withCors(response);
    } catch (error) {
      console.error("Trader worker error:", error);
      return withCors(
        jsonResponse({ success: false, error: "Internal server error" }, 500)
      );
    }
  };
}

/**
 * Checks if a request path matches the trader routes.
 * Useful for routing in hadoku-site.
 */
export function isTraderRoute(
  pathname: string,
  basePath = "/api/trader"
): boolean {
  return pathname.startsWith(basePath);
}
