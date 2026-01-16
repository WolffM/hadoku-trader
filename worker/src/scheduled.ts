/**
 * Scheduled task handlers for the trader worker.
 */

import { TraderEnv, ScraperDataPackage, Signal } from "./types";
import { generateId } from "./utils";
import { processAllPendingSignals, resetMonthlyBudgets } from "./agents";

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

    // Fetch data from hadoku-scraper every 8 hours
    if (cron === "0 */8 * * *") {
      await fetchFromScraper(env);
    }

    // Process pending signals every 6 hours (after scraper sync)
    if (cron === "0 */6 * * *") {
      await processSignals(env);
    }

    // Update performance history daily at midnight
    if (cron === "0 0 * * *") {
      await updatePerformanceHistory(env);
    }

    // Reset monthly budgets on 1st of month
    if (cron === "0 0 1 * *") {
      await resetBudgets(env);
    }
  };
}

/**
 * Fetch signals and market data from hadoku-scraper.
 * This is the primary data sync that runs every 8 hours.
 */
export async function fetchFromScraper(env: TraderEnv): Promise<void> {
  try {
    console.log("Fetching data from hadoku-scraper...");

    const resp = await fetch(`${env.SCRAPER_URL}/data-package`, {
      headers: {
        "X-API-Key": env.SCRAPER_API_KEY,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      console.error("Scraper fetch failed:", resp.status, await resp.text());
      return;
    }

    const data: ScraperDataPackage = await resp.json();
    console.log(
      `Received ${data.signals.length} signals, SP500: ${data.market_data.sp500.price}`
    );

    // Store new signals
    for (const signal of data.signals) {
      await storeSignal(env, signal);
    }

    // Update current prices for tracked tickers
    for (const quote of data.market_data.quotes) {
      await env.TRADER_DB.prepare(`
        UPDATE positions SET current_price = ?, updated_at = ? WHERE ticker = ?
      `)
        .bind(quote.price, new Date().toISOString(), quote.ticker)
        .run();
    }

    // Store S&P 500 reference price
    await env.TRADER_DB.prepare(`
      INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)
    `)
      .bind(
        "sp500_price",
        data.market_data.sp500.price.toString(),
        new Date().toISOString()
      )
      .run();

    console.log("Scraper sync completed");
  } catch (error) {
    console.error("Scraper fetch error:", error);
  }
}

/**
 * Store a signal in the database, handling duplicates.
 */
async function storeSignal(env: TraderEnv, signal: Signal): Promise<void> {
  // Check for duplicate
  const existing = await env.TRADER_DB.prepare(
    "SELECT id FROM signals WHERE source = ? AND source_id = ?"
  )
    .bind(signal.source, signal.meta.source_id)
    .first();

  if (existing) {
    return; // Already have this signal
  }

  const id = generateId("sig");

  await env.TRADER_DB.prepare(`
    INSERT INTO signals (
      id, source, politician_name, politician_chamber, politician_party, politician_state,
      ticker, action, asset_type, disclosed_price, disclosed_date, filing_date,
      position_size, position_size_min, position_size_max,
      source_url, source_id, scraped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      signal.trade.disclosed_price,
      signal.trade.disclosed_date,
      signal.trade.filing_date,
      signal.trade.position_size,
      signal.trade.position_size_min,
      signal.trade.position_size_max,
      signal.meta.source_url,
      signal.meta.source_id,
      signal.meta.scraped_at
    )
    .run();

  console.log(`Stored new signal: ${signal.trade.ticker} from ${signal.source}`);
}

/**
 * Update the performance history table with today's % returns.
 * Called daily at midnight.
 */
export async function updatePerformanceHistory(env: TraderEnv): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  // Calculate signals % return (theoretical return if following all signals)
  const signalsReturn = await calculateSignalsReturn(env);

  // Calculate hadoku % return (our executed trades)
  const hadokuReturn = await calculateHadokuReturn(env);

  // Get S&P 500 % return (from stored reference)
  const sp500Return = await calculateSP500Return(env);

  await env.TRADER_DB.prepare(`
    INSERT OR REPLACE INTO performance_history
    (date, signals_return_pct, hadoku_return_pct, sp500_return_pct)
    VALUES (?, ?, ?, ?)
  `)
    .bind(today, signalsReturn, hadokuReturn, sp500Return)
    .run();

  console.log(
    `Performance history updated for ${today}: signals=${signalsReturn.toFixed(2)}%, hadoku=${hadokuReturn.toFixed(2)}%, sp500=${sp500Return.toFixed(2)}%`
  );
}

/**
 * Calculate theoretical return if following all signals equally.
 */
async function calculateSignalsReturn(env: TraderEnv): Promise<number> {
  // Get all signals with disclosed prices and current prices
  const results = await env.TRADER_DB.prepare(`
    SELECT
      s.ticker,
      s.action,
      s.disclosed_price,
      p.current_price
    FROM signals s
    LEFT JOIN positions p ON s.ticker = p.ticker
    WHERE s.disclosed_price IS NOT NULL
      AND p.current_price IS NOT NULL
  `).all();

  if (results.results.length === 0) {
    return 0;
  }

  // Calculate average return across all signals
  let totalReturn = 0;
  let count = 0;

  for (const row of results.results as any[]) {
    const entryPrice = row.disclosed_price;
    const currentPrice = row.current_price;

    if (entryPrice > 0 && currentPrice > 0) {
      // For buy signals: positive when price goes up
      // For sell signals: positive when price goes down
      const returnPct =
        row.action === "buy"
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - currentPrice) / entryPrice) * 100;

      totalReturn += returnPct;
      count++;
    }
  }

  return count > 0 ? totalReturn / count : 0;
}

/**
 * Calculate return from our executed trades (hadoku signal).
 */
async function calculateHadokuReturn(env: TraderEnv): Promise<number> {
  // Get all executed trades with current prices
  const results = await env.TRADER_DB.prepare(`
    SELECT
      t.ticker,
      t.action,
      t.price as entry_price,
      t.quantity,
      p.current_price
    FROM trades t
    LEFT JOIN positions p ON t.ticker = p.ticker
    WHERE t.status = 'executed'
      AND t.price > 0
      AND p.current_price IS NOT NULL
  `).all();

  if (results.results.length === 0) {
    return 0;
  }

  // Calculate weighted average return
  let totalWeightedReturn = 0;
  let totalWeight = 0;

  for (const row of results.results as any[]) {
    const entryPrice = row.entry_price;
    const currentPrice = row.current_price;
    const weight = row.quantity * entryPrice; // Weight by position size

    if (entryPrice > 0 && currentPrice > 0) {
      const returnPct =
        row.action === "buy"
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - currentPrice) / entryPrice) * 100;

      totalWeightedReturn += returnPct * weight;
      totalWeight += weight;
    }
  }

  return totalWeight > 0 ? totalWeightedReturn / totalWeight : 0;
}

/**
 * Calculate S&P 500 return from stored reference price.
 */
async function calculateSP500Return(env: TraderEnv): Promise<number> {
  // Get starting SP500 price (first recorded)
  const startPrice = await env.TRADER_DB.prepare(`
    SELECT value FROM config WHERE key = 'sp500_start_price'
  `).first();

  // Get current SP500 price
  const currentPrice = await env.TRADER_DB.prepare(`
    SELECT value FROM config WHERE key = 'sp500_price'
  `).first();

  if (!startPrice?.value || !currentPrice?.value) {
    // If no start price set, use current as start
    if (currentPrice?.value && !startPrice?.value) {
      await env.TRADER_DB.prepare(`
        INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)
      `)
        .bind("sp500_start_price", currentPrice.value, new Date().toISOString())
        .run();
    }
    return 0;
  }

  const start = parseFloat(startPrice.value as string);
  const current = parseFloat(currentPrice.value as string);

  return start > 0 ? ((current - start) / start) * 100 : 0;
}

/**
 * Process all pending signals through the multi-agent trading engine.
 * Routes signals to all active agents and records their decisions.
 */
async function processSignals(env: TraderEnv): Promise<void> {
  try {
    console.log("Processing pending signals through agents...");

    const result = await processAllPendingSignals(env);

    console.log(
      `Processed ${result.processed_count} signals through agents`
    );

    // Log summary of decisions
    const executeCounts: Record<string, number> = {};
    const skipCounts: Record<string, number> = {};

    for (const signalResult of result.results) {
      for (const decision of signalResult.decisions) {
        if (decision.action === "execute" || decision.action === "execute_half") {
          executeCounts[decision.agent_id] = (executeCounts[decision.agent_id] || 0) + 1;
        } else {
          skipCounts[decision.agent_id] = (skipCounts[decision.agent_id] || 0) + 1;
        }
      }
    }

    console.log("Agent decisions summary:", {
      execute: executeCounts,
      skip: skipCounts,
    });
  } catch (error) {
    console.error("Error processing signals:", error);
  }
}

/**
 * Reset monthly budgets for all agents.
 * Called on the 1st of each month.
 */
async function resetBudgets(env: TraderEnv): Promise<void> {
  try {
    console.log("Resetting monthly budgets for all agents...");

    await resetMonthlyBudgets(env);

    console.log("Monthly budgets reset successfully");
  } catch (error) {
    console.error("Error resetting budgets:", error);
  }
}
