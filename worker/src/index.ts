/**
 * Hadoku Trader Worker - Exportable Package
 *
 * Usage in hadoku-site:
 *
 * ```typescript
 * import { createTraderHandler, type TraderEnv } from 'hadoku-trader/worker';
 *
 * // Extend your env to include TraderEnv
 * interface Env extends TraderEnv {
 *   // your other bindings
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const url = new URL(request.url);
 *
 *     // Mount trader routes
 *     if (url.pathname.startsWith('/api/trader')) {
 *       const handler = createTraderHandler(env);
 *       return handler(request);
 *     }
 *
 *     // ... other routes
 *   }
 * }
 * ```
 */

// Re-export all types
export * from "./types";

// Export handlers
export { createTraderHandler } from "./handler";
export { createScheduledHandler } from "./scheduled";

// Export individual route handlers for fine-grained control
export {
  handleGetSignals,
  handlePostSignal,
  handleGetPerformance,
  handleGetTrades,
  handleGetSources,
  handleExecuteTrade,
  handleHealth,
  handleGetAgents,
  handleGetAgentById,
  handleProcessSignals,
} from "./routes";

// Export the agents module for direct access
export * as agents from "./agents";
