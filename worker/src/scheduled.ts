/**
 * Scheduled task handlers for the trader worker.
 */

import { TraderEnv } from "./types";

/**
 * Creates a scheduled handler for cron jobs.
 *
 * Usage in hadoku-site:
 * ```typescript
 * import { createScheduledHandler } from 'hadoku-trader/worker';
 *
 * export default {
 *   async scheduled(event, env) {
 *     const handler = createScheduledHandler(env);
 *     await handler(event.cron);
 *   }
 * }
 * ```
 */
export function createScheduledHandler(
  env: TraderEnv
): (cron: string) => Promise<void> {
  return async (cron: string): Promise<void> => {
    console.log("Scheduled task running:", cron);

    // Update performance history daily at midnight
    if (cron === "0 0 * * *") {
      await updatePerformanceHistory(env);
    }

    // Sync portfolio from Fidelity every 8 hours
    if (cron === "0 */8 * * *") {
      await syncPortfolio(env);
    }
  };
}

/**
 * Update the performance history table with today's values.
 */
export async function updatePerformanceHistory(env: TraderEnv): Promise<void> {
  // Get current portfolio value
  const portfolio = await env.TRADER_DB.prepare(`
    SELECT SUM(quantity * avg_cost) as value FROM positions WHERE quantity > 0
  `).first();

  const portfolioValue = (portfolio?.value as number) || 10000;

  // Get S&P 500 value (placeholder - would fetch from market data)
  const sp500Value = 10000;

  // Get signals theoretical value (placeholder)
  const signalsValue = 10000;

  const today = new Date().toISOString().split("T")[0];

  await env.TRADER_DB.prepare(`
    INSERT OR REPLACE INTO performance_history (date, signals_value, portfolio_value, sp500_value)
    VALUES (?, ?, ?, ?)
  `)
    .bind(today, signalsValue, portfolioValue, sp500Value)
    .run();

  console.log("Performance history updated for", today);
}

/**
 * Sync portfolio positions from Fidelity via the trader-worker tunnel.
 */
export async function syncPortfolio(env: TraderEnv): Promise<void> {
  try {
    const resp = await fetch(`${env.TUNNEL_URL}/accounts`, {
      headers: { "X-API-Key": env.TRADER_API_KEY },
    });

    if (!resp.ok) {
      console.error("Portfolio sync failed:", resp.status);
      return;
    }

    const data: any = await resp.json();

    // Update positions in DB
    for (const account of data.accounts || []) {
      for (const position of account.positions || []) {
        await env.TRADER_DB.prepare(`
          INSERT OR REPLACE INTO positions (ticker, quantity, avg_cost, current_price, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(
            position.ticker,
            position.quantity,
            position.last_price,
            position.last_price,
            new Date().toISOString()
          )
          .run();
      }
    }

    console.log("Portfolio sync completed");
  } catch (error) {
    console.error("Portfolio sync error:", error);
  }
}
