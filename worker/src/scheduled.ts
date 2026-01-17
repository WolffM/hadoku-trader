/**
 * Scheduled task handlers for the trader worker.
 */

import { TraderEnv, ScraperDataPackage, Signal } from "./types";
import { generateId } from "./utils";
import { processAllPendingSignals, resetMonthlyBudgets, monitorPositions } from "./agents";

// =============================================================================
// Market Prices Types
// =============================================================================

interface MarketPriceRecord {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface MarketHistoricalResponse {
  success: boolean;
  data: {
    records: MarketPriceRecord[];
    record_count: number;
    ticker_count: number;
    start_date: string;
    end_date: string;
  };
}

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

    // Main sync: fetch data, process signals, update performance, handle monthly budget
    if (cron === "0 */8 * * *") {
      await runFullSync(env);
    }

    // Monitor positions every 15 minutes during market hours (9am-4pm ET, Mon-Fri)
    // Note: Cloudflare cron uses UTC, adjust times accordingly
    if (cron === "*/15 14-21 * * 1-5") {
      await monitorAllPositions(env);
    }
  };
}

/**
 * Run the full sync: fetch data, process signals, update performance, handle monthly budget.
 * This is the main scheduled job that runs every 8 hours.
 */
export async function runFullSync(env: TraderEnv): Promise<void> {
  const startTime = Date.now();
  console.log("=== Starting full sync ===");

  try {
    // 1. Fetch signals and market data from scraper
    await fetchFromScraper(env);

    // 2. Sync historical market prices
    await syncMarketPrices(env);

    // 3. Process pending signals through agents
    await processSignals(env);

    // 4. Update performance history
    await updatePerformanceHistory(env);

    // 5. Check if we need to add monthly budget (1st of month)
    const today = new Date();
    if (today.getUTCDate() === 1) {
      // Only run once on the 1st - check if we already did it today
      const lastBudgetAdd = await env.TRADER_DB.prepare(
        "SELECT value FROM config WHERE key = 'last_budget_add_date'"
      ).first();

      const todayStr = today.toISOString().split("T")[0];
      if (lastBudgetAdd?.value !== todayStr) {
        await resetBudgets(env);
        await env.TRADER_DB.prepare(
          "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)"
        )
          .bind("last_budget_add_date", todayStr, new Date().toISOString())
          .run();
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`=== Full sync completed in ${elapsed}s ===`);
  } catch (error) {
    console.error("Full sync error:", error);
  }
}

/**
 * Fetch signals and market data from hadoku-scraper.
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

    console.log("Scraper data sync completed");
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
      ticker, action, asset_type, disclosed_price, price_at_filing, disclosed_date, filing_date,
      position_size, position_size_min, position_size_max,
      option_type, strike_price, expiration_date,
      source_url, source_id, scraped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      signal.trade.price_at_filing,
      signal.trade.disclosed_date,
      signal.trade.filing_date,
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

/**
 * Monitor all open positions and execute exits as needed.
 * Called every 15 minutes during market hours.
 */
async function monitorAllPositions(env: TraderEnv): Promise<void> {
  try {
    console.log("Monitoring positions for exit conditions...");

    const result = await monitorPositions(env);

    console.log(
      `Position monitoring complete: ${result.positions_checked} checked, ${result.exits_triggered} exits`
    );

    if (result.exits.length > 0) {
      console.log("Exits executed:", result.exits);
    }

    if (result.highest_price_updates > 0) {
      console.log(`Updated ${result.highest_price_updates} highest prices`);
    }

    if (result.errors.length > 0) {
      console.warn("Monitoring errors:", result.errors);
    }
  } catch (error) {
    console.error("Error monitoring positions:", error);
  }
}

// =============================================================================
// Market Prices Sync
// =============================================================================

/**
 * Sync market prices from hadoku-scrape.
 * Fetches historical OHLCV data for all tickers we're tracking.
 * Called daily after market close.
 */
export async function syncMarketPrices(env: TraderEnv): Promise<void> {
  try {
    console.log("Syncing market prices from hadoku-scrape...");

    // Get unique tickers from signals and positions
    const tickersResult = await env.TRADER_DB.prepare(`
      SELECT DISTINCT ticker FROM (
        SELECT ticker FROM signals
        UNION
        SELECT ticker FROM positions WHERE status = 'open'
        UNION
        SELECT ticker FROM agent_positions WHERE status = 'open'
      )
      ORDER BY ticker
    `).all();

    const allTickers = tickersResult.results.map((r) => r.ticker as string);

    if (allTickers.length === 0) {
      console.log("No tickers to sync");
      return;
    }

    console.log(`Found ${allTickers.length} tickers to sync`);

    // Determine date range: last 7 days for daily updates
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    // Batch into groups of 100 (API limit)
    const batchSize = 100;
    let totalInserted = 0;
    let totalErrors = 0;

    for (let i = 0; i < allTickers.length; i += batchSize) {
      const batch = allTickers.slice(i, i + batchSize);
      console.log(
        `Fetching batch ${Math.floor(i / batchSize) + 1}: ${batch.length} tickers`
      );

      try {
        const response = await fetch(
          `${env.SCRAPER_URL}/api/v1/market/historical`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.SCRAPER_API_KEY}`,
            },
            body: JSON.stringify({
              tickers: batch,
              start_date: startDate,
              end_date: endDate,
            }),
          }
        );

        if (!response.ok) {
          console.error(
            `Market prices fetch failed for batch: ${response.status}`
          );
          totalErrors += batch.length;
          continue;
        }

        const result: MarketHistoricalResponse = await response.json();
        console.log(
          `Received ${result.data.record_count} prices for ${result.data.ticker_count} tickers`
        );

        // Store prices in D1
        for (const price of result.data.records) {
          try {
            await env.TRADER_DB.prepare(`
              INSERT OR REPLACE INTO market_prices
              (ticker, date, open, high, low, close, volume, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'yahoo')
            `)
              .bind(
                price.ticker,
                price.date,
                price.open,
                price.high,
                price.low,
                price.close,
                price.volume ?? null
              )
              .run();

            totalInserted++;
          } catch (error) {
            console.error(`Error inserting price for ${price.ticker}:`, error);
            totalErrors++;
          }
        }
      } catch (error) {
        console.error(`Error fetching batch:`, error);
        totalErrors += batch.length;
      }
    }

    console.log(
      `Market prices sync complete: ${totalInserted} inserted, ${totalErrors} errors`
    );
  } catch (error) {
    console.error("Error syncing market prices:", error);
  }
}

/**
 * Backfill historical market prices for simulation/backtesting.
 * Call this manually to populate historical data.
 *
 * @param env - Environment with DB and API keys
 * @param startDate - Start date (YYYY-MM-DD)
 * @param endDate - End date (YYYY-MM-DD)
 * @param tickers - Optional specific tickers (defaults to all from signals)
 */
export async function backfillMarketPrices(
  env: TraderEnv,
  startDate: string,
  endDate: string,
  tickers?: string[]
): Promise<{ inserted: number; errors: number }> {
  console.log(`Backfilling market prices from ${startDate} to ${endDate}...`);

  // Get tickers from signals if not provided
  if (!tickers || tickers.length === 0) {
    const tickersResult = await env.TRADER_DB.prepare(`
      SELECT DISTINCT ticker FROM signals ORDER BY ticker
    `).all();
    tickers = tickersResult.results.map((r) => r.ticker as string);
  }

  if (tickers.length === 0) {
    console.log("No tickers to backfill");
    return { inserted: 0, errors: 0 };
  }

  console.log(`Backfilling ${tickers.length} tickers`);

  const batchSize = 100;
  let totalInserted = 0;
  let totalErrors = 0;

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    console.log(
      `Backfilling batch ${Math.floor(i / batchSize) + 1}: ${batch.length} tickers`
    );

    try {
      const response = await fetch(
        `${env.SCRAPER_URL}/api/v1/market/historical`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.SCRAPER_API_KEY}`,
          },
          body: JSON.stringify({
            tickers: batch,
            start_date: startDate,
            end_date: endDate,
          }),
        }
      );

      if (!response.ok) {
        console.error(`Backfill fetch failed: ${response.status}`);
        totalErrors += batch.length;
        continue;
      }

      const result: MarketHistoricalResponse = await response.json();
      console.log(
        `Received ${result.data.record_count} prices for ${result.data.ticker_count} tickers`
      );

      for (const price of result.data.records) {
        try {
          await env.TRADER_DB.prepare(`
            INSERT OR REPLACE INTO market_prices
            (ticker, date, open, high, low, close, volume, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'yahoo')
          `)
            .bind(
              price.ticker,
              price.date,
              price.open,
              price.high,
              price.low,
              price.close,
              price.volume ?? null
            )
            .run();

          totalInserted++;
        } catch (error) {
          console.error(`Error inserting price for ${price.ticker}:`, error);
          totalErrors++;
        }
      }
    } catch (error) {
      console.error(`Error fetching batch:`, error);
      totalErrors += batch.length;
    }
  }

  console.log(
    `Backfill complete: ${totalInserted} inserted, ${totalErrors} errors`
  );
  return { inserted: totalInserted, errors: totalErrors };
}
