/**
 * Scheduled task handlers for the trader worker.
 */

import type { TraderEnv, Signal } from './types'
import { insertSignal } from './utils'
import { processAllPendingSignals, resetMonthlyBudgets, monitorPositions } from './agents'

// =============================================================================
// Market Prices Types
// =============================================================================

interface MarketPriceRecord {
  ticker: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

interface MarketHistoricalResponse {
  success: boolean
  data: {
    records: MarketPriceRecord[]
    record_count: number
    ticker_count: number
    start_date: string
    end_date: string
  }
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
export function createScheduledHandler(env: TraderEnv): (cron: string) => Promise<void> {
  return async (cron: string): Promise<void> => {
    console.log('Scheduled task running:', cron)

    // Main sync: fetch data, process signals, update performance, handle monthly budget
    if (cron === '0 */8 * * *') {
      await runFullSync(env)
    }

    // Monitor positions every 15 minutes during market hours (9am-4pm ET, Mon-Fri)
    // Note: Cloudflare cron uses UTC, adjust times accordingly
    if (cron === '*/15 14-21 * * 1-5') {
      try {
        console.log('Monitoring positions for exit conditions...')
        const result = await monitorPositions(env)
        console.log(
          `Position monitoring complete: ${result.positions_checked} checked, ${result.exits_triggered} exits`
        )
        if (result.exits.length > 0) {
          console.log('Exits executed:', result.exits)
        }
        if (result.errors.length > 0) {
          console.warn('Monitoring errors:', result.errors)
        }
      } catch (error) {
        console.error('Error monitoring positions:', error)
      }
    }
  }
}

/**
 * Run the full sync: fetch data, process signals, update performance, handle monthly budget.
 * This is the main scheduled job that runs every 8 hours.
 */
export async function runFullSync(env: TraderEnv): Promise<void> {
  const startTime = Date.now()
  console.log('=== Starting full sync ===')

  try {
    // 1. Fetch signals from scraper using incremental sync
    const syncResult = await syncSignalsFromScraper(env)
    if (syncResult.errors.length > 0) {
      console.warn('Signal sync had errors:', syncResult.errors)
    }

    // 2. Sync historical market prices
    await syncMarketPrices(env)

    // 3. Process pending signals through agents
    console.log('Processing pending signals through agents...')
    const processResult = await processAllPendingSignals(env)
    console.log(`Processed ${processResult.processed_count} signals through agents`)

    // 4. Update performance history
    await updatePerformanceHistory(env)

    // 5. Check if we need to add monthly budget (1st of month)
    const today = new Date()
    if (today.getUTCDate() === 1) {
      // Only run once on the 1st - check if we already did it today
      const lastBudgetAdd = await env.TRADER_DB.prepare(
        "SELECT value FROM config WHERE key = 'last_budget_add_date'"
      ).first()

      const todayStr = today.toISOString().split('T')[0]
      if (lastBudgetAdd?.value !== todayStr) {
        console.log('Resetting monthly budgets for all agents...')
        await resetMonthlyBudgets(env)
        console.log('Monthly budgets reset successfully')
        await env.TRADER_DB.prepare(
          'INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)'
        )
          .bind('last_budget_add_date', todayStr, new Date().toISOString())
          .run()
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`=== Full sync completed in ${elapsed}s ===`)
  } catch (error) {
    console.error('Full sync error:', error)
  }
}

// Use generated types from scraper OpenAPI
import type { components } from './generated/scraper-api'

/**
 * Response from scraper /api/v1/politrades/signals/pull endpoint.
 * Used for incremental sync with cursor pagination.
 */
type ScraperPullResponse = components['schemas']['SignalsPullResponse']

/**
 * Scraper's Signal type from OpenAPI spec.
 * More permissive than our internal Signal type (allows null/optional fields).
 */
type ScraperSignal = components['schemas']['Signal']

// =============================================================================
// Incremental Sync Helpers
// =============================================================================

/**
 * Get the latest disclosure date from signals in D1.
 * Used to determine the starting point for incremental sync.
 */
async function getLatestDisclosureDate(env: TraderEnv): Promise<string | null> {
  const result = await env.TRADER_DB.prepare(
    `
    SELECT MAX(disclosure_date) as latest FROM signals
  `
  ).first<{ latest: string | null }>()
  return result?.latest ?? null
}

/**
 * Convert a scraper signal to our internal Signal format.
 * Provides defaults for optional fields that the scraper may not include.
 */
function toInternalSignal(scraperSignal: ScraperSignal): Signal {
  return {
    source: scraperSignal.source,
    politician: {
      name: scraperSignal.politician.name,
      chamber: scraperSignal.politician.chamber ?? 'unknown',
      party: scraperSignal.politician.party ?? 'unknown',
      state: scraperSignal.politician.state ?? 'unknown'
    },
    trade: {
      ticker: scraperSignal.trade.ticker ?? '',
      action: scraperSignal.trade.action,
      asset_type: scraperSignal.trade.asset_type ?? 'stock',
      trade_date: scraperSignal.trade.trade_date ?? '',
      trade_price: scraperSignal.trade.trade_price ?? null,
      disclosure_date: scraperSignal.trade.disclosure_date ?? '',
      disclosure_price: scraperSignal.trade.disclosure_price ?? null,
      disclosure_lag_days: scraperSignal.trade.disclosure_lag_days ?? undefined,
      current_price: scraperSignal.trade.current_price ?? null,
      current_price_at: null,
      position_size: scraperSignal.trade.position_size ?? '',
      position_size_min: scraperSignal.trade.position_size_min ?? 0,
      position_size_max: scraperSignal.trade.position_size_max ?? 0,
      option_type: (scraperSignal.trade.option_type as 'call' | 'put' | null) ?? null,
      strike_price: scraperSignal.trade.strike_price ?? null,
      expiration_date: scraperSignal.trade.expiration_date ?? null
    },
    meta: {
      source_url: scraperSignal.meta.source_url ?? '',
      source_id: scraperSignal.meta.source_id,
      scraped_at: scraperSignal.meta.scraped_at
    }
  }
}

// =============================================================================
// Public Signal Sync Functions
// =============================================================================

/**
 * Result of syncing signals from the scraper.
 */
export interface SignalSyncResult {
  inserted: number
  skipped: number
  errors: string[]
}

/**
 * Fetch and sync signals from hadoku-scraper into D1 using incremental pull.
 *
 * This is the canonical function for signal acquisition - call it from scheduled
 * handlers or manually to sync new signals. Uses cursor pagination to handle
 * large result sets and incremental sync based on the latest disclosure date.
 *
 * @param env - Environment with SCRAPER_URL, SCRAPER_API_KEY, and TRADER_DB
 * @returns Counts of inserted, skipped (duplicates), and any errors
 */
export async function syncSignalsFromScraper(env: TraderEnv): Promise<SignalSyncResult> {
  const result: SignalSyncResult = { inserted: 0, skipped: 0, errors: [] }

  try {
    // Get latest disclosure date we have for incremental sync
    const sinceDate = await getLatestDisclosureDate(env)
    console.log(`Fetching signals from hadoku-scraper (since: ${sinceDate ?? 'beginning'})...`)

    // Use incremental pull endpoint with cursor pagination
    let cursor: string | null = null
    let hasMore = true
    let pageCount = 0
    const maxPages = 50 // Safety limit

    while (hasMore && pageCount < maxPages) {
      pageCount++

      // Build URL with parameters
      const params = new URLSearchParams()
      if (sinceDate) params.set('since', sinceDate)
      if (cursor) params.set('cursor', cursor)

      const url = `${env.SCRAPER_URL}/api/v1/politrades/signals/pull?${params.toString()}`

      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${env.SCRAPER_API_KEY}`,
          Accept: 'application/json'
        }
      })

      if (!resp.ok) {
        const errorText = await resp.text()
        result.errors.push(`Scraper fetch failed: ${resp.status} - ${errorText}`)
        return result
      }

      const data: ScraperPullResponse = await resp.json()

      console.log(`Page ${pageCount}: ${data.signals.length} signals (has_more: ${data.has_more})`)

      // Convert and ingest signals
      const signals = data.signals.map(toInternalSignal)
      const batchResult = await ingestSignalBatch(env, signals)
      result.inserted += batchResult.inserted
      result.skipped += batchResult.skipped
      result.errors.push(...batchResult.errors)

      // Update pagination state
      cursor = data.next_cursor ?? null
      hasMore = data.has_more
    }

    if (pageCount >= maxPages) {
      console.warn(`Hit max pages limit (${maxPages}), may have more signals`)
    }

    console.log(
      `Signal sync complete: ${result.inserted} inserted, ${result.skipped} skipped, ${result.errors.length} errors`
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    result.errors.push(`Scraper sync error: ${errorMsg}`)
    console.error('Scraper sync error:', error)
  }

  return result
}

/**
 * Ingest a batch of signals into D1, handling duplicates.
 *
 * Use this for webhook batches from scraper backfill, or any bulk signal import.
 *
 * @param env - Environment with TRADER_DB
 * @param signals - Array of signals to insert
 * @returns Counts of inserted, skipped (duplicates), and any errors
 */
export async function ingestSignalBatch(
  env: TraderEnv,
  signals: Signal[]
): Promise<SignalSyncResult> {
  const result: SignalSyncResult = { inserted: 0, skipped: 0, errors: [] }

  for (const signal of signals) {
    // Skip signals without a ticker - they're not actionable
    if (!signal.trade?.ticker) {
      console.log(`Skipping signal without ticker: ${signal.meta?.source_id ?? 'unknown'}`)
      result.skipped++
      continue
    }

    try {
      const insertResult = await insertSignal(env, signal)

      if (insertResult.duplicate) {
        result.skipped++
      } else {
        result.inserted++
        console.log(`Stored signal: ${signal.trade.ticker} from ${signal.source}`)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      result.errors.push(
        `Failed to insert signal ${signal.meta?.source_id ?? 'unknown'}: ${errorMsg}`
      )
      console.error('Error inserting signal:', error)
    }
  }

  return result
}

/**
 * Update the performance history table with today's % returns.
 * Called daily at midnight.
 */
export async function updatePerformanceHistory(env: TraderEnv): Promise<void> {
  const today = new Date().toISOString().split('T')[0]

  // Calculate signals % return (theoretical return if following all signals)
  const signalsReturn = await calculateSignalsReturn(env)

  // Calculate hadoku % return (our executed trades)
  const hadokuReturn = await calculateHadokuReturn(env)

  // Get S&P 500 % return (from stored reference)
  const sp500Return = await calculateSP500Return(env)

  await env.TRADER_DB.prepare(
    `
    INSERT OR REPLACE INTO performance_history
    (date, signals_return_pct, hadoku_return_pct, sp500_return_pct)
    VALUES (?, ?, ?, ?)
  `
  )
    .bind(today, signalsReturn, hadokuReturn, sp500Return)
    .run()

  console.log(
    `Performance history updated for ${today}: signals=${signalsReturn.toFixed(2)}%, hadoku=${hadokuReturn.toFixed(2)}%, sp500=${sp500Return.toFixed(2)}%`
  )
}

/**
 * Calculate theoretical return if following all signals equally.
 * Uses latest market prices from market_prices table.
 */
async function calculateSignalsReturn(env: TraderEnv): Promise<number> {
  // Get signals with trade prices and latest market prices
  const results = await env.TRADER_DB.prepare(
    `SELECT
      s.ticker,
      s.action,
      s.trade_price,
      mp.close as current_price
    FROM signals s
    INNER JOIN (
      SELECT ticker, close, MAX(date) as max_date
      FROM market_prices
      GROUP BY ticker
    ) mp ON s.ticker = mp.ticker
    WHERE s.trade_price IS NOT NULL`
  ).all()

  if (results.results.length === 0) {
    return 0
  }

  // Calculate average return across all signals
  let totalReturn = 0
  let count = 0

  for (const row of results.results as {
    trade_price: number
    current_price: number
    action: string
  }[]) {
    if (row.trade_price > 0 && row.current_price > 0) {
      // For buy signals: positive when price goes up
      // For sell signals: positive when price goes down
      const returnPct =
        row.action === 'buy'
          ? ((row.current_price - row.trade_price) / row.trade_price) * 100
          : ((row.trade_price - row.current_price) / row.trade_price) * 100

      totalReturn += returnPct
      count++
    }
  }

  return count > 0 ? totalReturn / count : 0
}

/**
 * Calculate return from our executed trades across all agents.
 * Uses latest market prices from market_prices table.
 */
async function calculateHadokuReturn(env: TraderEnv): Promise<number> {
  // Get executed trades with latest market prices
  const results = await env.TRADER_DB.prepare(
    `SELECT
      t.ticker,
      t.action,
      t.price as entry_price,
      t.quantity,
      mp.close as current_price
    FROM trades t
    INNER JOIN (
      SELECT ticker, close, MAX(date) as max_date
      FROM market_prices
      GROUP BY ticker
    ) mp ON t.ticker = mp.ticker
    WHERE t.status = 'executed' AND t.price > 0`
  ).all()

  if (results.results.length === 0) {
    return 0
  }

  // Calculate weighted average return
  let totalWeightedReturn = 0
  let totalWeight = 0

  for (const row of results.results as {
    entry_price: number
    current_price: number
    quantity: number
    action: string
  }[]) {
    const weight = row.quantity * row.entry_price // Weight by position size

    if (row.entry_price > 0 && row.current_price > 0) {
      const returnPct =
        row.action === 'buy'
          ? ((row.current_price - row.entry_price) / row.entry_price) * 100
          : ((row.entry_price - row.current_price) / row.entry_price) * 100

      totalWeightedReturn += returnPct * weight
      totalWeight += weight
    }
  }

  return totalWeight > 0 ? totalWeightedReturn / totalWeight : 0
}

/**
 * Calculate S&P 500 return from stored reference price.
 */
async function calculateSP500Return(env: TraderEnv): Promise<number> {
  // Get starting SP500 price (first recorded)
  const startPrice = await env.TRADER_DB.prepare(
    `
    SELECT value FROM config WHERE key = 'sp500_start_price'
  `
  ).first()

  // Get current SP500 price
  const currentPrice = await env.TRADER_DB.prepare(
    `
    SELECT value FROM config WHERE key = 'sp500_price'
  `
  ).first()

  if (!startPrice?.value || !currentPrice?.value) {
    // If no start price set, use current as start
    if (currentPrice?.value && !startPrice?.value) {
      await env.TRADER_DB.prepare(
        `
        INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)
      `
      )
        .bind('sp500_start_price', currentPrice.value, new Date().toISOString())
        .run()
    }
    return 0
  }

  const start = parseFloat(startPrice.value as string)
  const current = parseFloat(currentPrice.value as string)

  return start > 0 ? ((current - start) / start) * 100 : 0
}

// =============================================================================
// Market Prices Sync
// =============================================================================

/** Batch size for D1 insert operations */
const D1_BATCH_SIZE = 50

/**
 * Insert market price records into D1 using batch operations.
 * @returns Count of inserted records and errors
 */
async function insertMarketPrices(
  env: TraderEnv,
  records: MarketPriceRecord[]
): Promise<{ inserted: number; errors: number }> {
  let inserted = 0
  let errors = 0

  for (let i = 0; i < records.length; i += D1_BATCH_SIZE) {
    const batch = records.slice(i, i + D1_BATCH_SIZE)
    const statements = batch.map(price =>
      env.TRADER_DB.prepare(
        `INSERT OR REPLACE INTO market_prices
         (ticker, date, open, high, low, close, volume, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'yahoo')`
      ).bind(
        price.ticker,
        price.date,
        price.open,
        price.high,
        price.low,
        price.close,
        price.volume ?? null
      )
    )

    try {
      await env.TRADER_DB.batch(statements)
      inserted += batch.length
    } catch (error) {
      console.error(`Error inserting batch of ${batch.length} prices:`, error)
      errors += batch.length
    }
  }

  return { inserted, errors }
}

/**
 * Fetch market prices from scraper API with exponential backoff retry.
 */
async function fetchMarketPricesWithRetry(
  env: TraderEnv,
  tickers: string[],
  startDate: string,
  endDate: string,
  maxRetries = 3
): Promise<MarketHistoricalResponse | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${env.SCRAPER_URL}/api/v1/market/historical`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SCRAPER_API_KEY}`
        },
        body: JSON.stringify({
          tickers,
          start_date: startDate,
          end_date: endDate
        })
      })

      // Retry on rate limit (429) or server error (5xx)
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000
          console.log(
            `Rate limited/error (${response.status}), retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`
          )
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        return null
      }

      if (!response.ok) {
        console.error(`Market prices fetch failed: ${response.status}`)
        return null
      }

      return await response.json()
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000
        console.log(`Network error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      console.error('Market prices fetch error:', error)
      return null
    }
  }
  return null
}

/**
 * Sync market prices from hadoku-scraper.
 * Fetches historical OHLCV data for all tickers we're tracking.
 * Called daily after market close.
 */
export async function syncMarketPrices(env: TraderEnv): Promise<void> {
  try {
    console.log('Syncing market prices from hadoku-scraper...')

    // Get unique tickers from signals and positions
    const tickersResult = await env.TRADER_DB.prepare(
      `SELECT DISTINCT ticker FROM (
        SELECT ticker FROM signals
        UNION
        SELECT ticker FROM positions WHERE status = 'open'
      ) ORDER BY ticker`
    ).all()

    const allTickers = tickersResult.results.map(r => r.ticker as string)

    if (allTickers.length === 0) {
      console.log('No tickers to sync')
      return
    }

    console.log(`Found ${allTickers.length} tickers to sync`)

    // Last 30 days to catch gaps from infrequent tickers
    const endDate = new Date().toISOString().split('T')[0]
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const batchSize = 100
    let totalInserted = 0
    let totalErrors = 0

    for (let i = 0; i < allTickers.length; i += batchSize) {
      const batch = allTickers.slice(i, i + batchSize)
      console.log(`Fetching batch ${Math.floor(i / batchSize) + 1}: ${batch.length} tickers`)

      const result = await fetchMarketPricesWithRetry(env, batch, startDate, endDate)
      if (!result) {
        totalErrors += batch.length
        continue
      }

      console.log(
        `Received ${result.data.record_count} prices for ${result.data.ticker_count} tickers`
      )

      const insertResult = await insertMarketPrices(env, result.data.records)
      totalInserted += insertResult.inserted
      totalErrors += insertResult.errors
    }

    console.log(`Market prices sync complete: ${totalInserted} inserted, ${totalErrors} errors`)
  } catch (error) {
    console.error('Error syncing market prices:', error)
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
  console.log(`Backfilling market prices from ${startDate} to ${endDate}...`)

  // Get tickers from signals if not provided
  if (!tickers || tickers.length === 0) {
    const tickersResult = await env.TRADER_DB.prepare(
      `SELECT DISTINCT ticker FROM signals ORDER BY ticker`
    ).all()
    tickers = tickersResult.results.map(r => r.ticker as string)
  }

  if (tickers.length === 0) {
    console.log('No tickers to backfill')
    return { inserted: 0, errors: 0 }
  }

  console.log(`Backfilling ${tickers.length} tickers`)

  // Smaller batch size for backfill to stay under subrequest limits
  const batchSize = 20
  let totalInserted = 0
  let totalErrors = 0

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize)
    console.log(`Backfilling batch ${Math.floor(i / batchSize) + 1}: ${batch.length} tickers`)

    const result = await fetchMarketPricesWithRetry(env, batch, startDate, endDate)
    if (!result) {
      totalErrors += batch.length
      continue
    }

    console.log(
      `Received ${result.data.record_count} prices for ${result.data.ticker_count} tickers`
    )

    const insertResult = await insertMarketPrices(env, result.data.records)
    totalInserted += insertResult.inserted
    totalErrors += insertResult.errors
  }

  console.log(`Backfill complete: ${totalInserted} inserted, ${totalErrors} errors`)
  return { inserted: totalInserted, errors: totalErrors }
}
