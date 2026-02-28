/**
 * Individual route handlers for the trader worker.
 * These can be used directly or through createTraderHandler.
 */

import {
  type TraderEnv,
  type Signal,
  type ExecuteTradeRequest,
  type ExecuteTradeResponse,
  type BackfillBatchPayload,
  type BackfillSignal,
  type MarketPricesBackfillPayload,
  type MarketPriceData,
  type MarketBackfillTriggerRequest,
  getAdminKey
} from './types'
import {
  jsonResponse,
  verifyApiKey,
  generateId,
  insertSignal,
  checkSignalExists,
  checkLogicalDuplicate,
  insertSignalRow,
  PriceValidationError
} from './utils'
import {
  daysBetween,
  getCurrentDate,
  getActiveAgents,
  getAgent,
  getAgentBudget,
  getAgentPositions,
  processAllPendingSignals,
  TRADING_AGENTS,
  AGENT_CONFIGS,
  calculateScoreSync,
  getDetailedScoring,
  calculatePositionSize,
  type EnrichedSignal,
  type AgentConfig,
  type ScoringBreakdown
} from './agents'
import { backfillMarketPrices } from './scheduled'

// =============================================================================
// Signal Handlers
// =============================================================================

export async function handleGetSignals(env: TraderEnv): Promise<Response> {
  const results = await env.TRADER_DB.prepare(
    `
    SELECT * FROM signals
    ORDER BY scraped_at DESC
    LIMIT 100
  `
  ).all()

  const signals = results.results.map((row: any) => ({
    id: row.id,
    source: row.source,
    politician: {
      name: row.politician_name,
      chamber: row.politician_chamber,
      party: row.politician_party,
      state: row.politician_state
    },
    trade: {
      ticker: row.ticker,
      action: row.action,
      asset_type: row.asset_type,
      trade_price: row.trade_price,
      trade_date: row.trade_date,
      disclosure_price: row.disclosure_price,
      disclosure_date: row.disclosure_date,
      disclosure_lag_days: row.disclosure_lag_days,
      current_price: row.current_price,
      current_price_at: row.current_price_at,
      position_size: row.position_size,
      position_size_min: row.position_size_min,
      position_size_max: row.position_size_max
    },
    meta: {
      source_url: row.source_url,
      source_id: row.source_id,
      scraped_at: row.scraped_at
    }
  }))

  return jsonResponse({
    signals,
    last_updated: new Date().toISOString()
  })
}

export async function handlePostSignal(request: Request, env: TraderEnv): Promise<Response> {
  // Verify API key from scraper
  if (!verifyApiKey(request, env, 'SCRAPER_API_KEY')) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
  }

  const signal: Signal = await request.json()

  const result = await insertSignal(env, signal)

  if (result.duplicate) {
    return jsonResponse({
      success: true,
      message: 'Signal already exists',
      id: result.id,
      duplicate: true
    })
  }

  return jsonResponse({
    success: true,
    message: 'Signal received',
    id: result.id
  })
}

// =============================================================================
// Backfill Webhook Handler
// =============================================================================

/**
 * POST /signals/backfill - Receive batch of signals from hadoku-scrape backfill
 *
 * Expected webhook payload from hadoku-scrape:
 * {
 *   "event": "backfill.batch",
 *   "job_id": "...",
 *   "batch_number": 1,
 *   "source": "capitol_trades",
 *   "signals": [...],
 *   "is_last_batch": false
 * }
 */
export async function handleBackfillBatch(request: Request, env: TraderEnv): Promise<Response> {
  // Verify API key from scraper
  if (!verifyApiKey(request, env, 'SCRAPER_API_KEY')) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
  }

  const payload: BackfillBatchPayload = await request.json()

  // Extract fields from either payload.data or top-level (scraper uses payload.data)
  const jobId = payload.data?.job_id ?? payload.job_id
  const batchNumber = payload.data?.batch_number ?? payload.batch_number
  const source = payload.data?.source ?? payload.source

  // Validate event type
  if (payload.event !== 'backfill.batch' && payload.event !== 'backfill.completed') {
    return jsonResponse({
      success: true,
      message: `Ignored event: ${payload.event}`
    })
  }

  // Handle completion event
  if (payload.event === 'backfill.completed') {
    console.log(`Backfill job ${jobId} completed`)
    return jsonResponse({
      success: true,
      message: 'Backfill completed acknowledged',
      job_id: jobId
    })
  }

  // Process batch of signals (support both payload.data.signals and payload.signals)
  const signals: BackfillSignal[] = payload.data?.signals || payload.signals || []
  let inserted = 0
  let duplicates = 0
  let errors = 0
  let priceErrors = 0

  for (const signal of signals) {
    try {
      // Check for duplicate by source + source_id
      const existing = await checkSignalExists(
        env,
        signal.source ?? null,
        signal.meta?.source_id ?? null
      )

      if (existing) {
        duplicates++
        continue
      }

      // Check for logical duplicate (same ticker, politician, trade_date, action)
      const logicalDupe = await checkLogicalDuplicate(
        env,
        signal.trade?.ticker,
        signal.politician?.name,
        signal.trade?.trade_date,
        signal.trade?.action
      )

      if (logicalDupe) {
        duplicates++
        continue
      }

      // Insert new signal using shared function with lenient mode for backfill data
      const id = generateId('sig')
      await insertSignalRow(env, id, signal, { lenient: true })

      inserted++
    } catch (error) {
      if (error instanceof PriceValidationError) {
        console.warn(`[backfill] Price validation failed: ${error.message}`)
        priceErrors++
      } else {
        console.error('Error inserting signal:', error)
      }
      errors++
    }
  }

  console.log(
    `Backfill batch ${batchNumber} from ${source}: ` +
      `${inserted} inserted, ${duplicates} duplicates, ${errors} errors (${priceErrors} price validation)`
  )

  return jsonResponse({
    success: true,
    job_id: jobId,
    batch_number: batchNumber,
    inserted,
    duplicates,
    errors,
    price_errors: priceErrors,
    total_received: signals.length
  })
}

// =============================================================================
// Market Prices Backfill Handler
// =============================================================================

/**
 * POST /market/backfill - Receive batch of market prices from hadoku-scrape
 *
 * Expected payload:
 * {
 *   "event": "market.backfill",
 *   "data": {
 *     "prices": [
 *       { "ticker": "NVDA", "date": "2025-10-16", "open": 478.50, "high": 485.20, "low": 475.00, "close": 482.30, "volume": 45000000 },
 *       ...
 *     ],
 *     "source": "yahoo"
 *   }
 * }
 */
export async function handleMarketPricesBackfill(
  request: Request,
  env: TraderEnv
): Promise<Response> {
  // Verify API key from scraper
  if (!verifyApiKey(request, env, 'SCRAPER_API_KEY')) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
  }

  const payload: MarketPricesBackfillPayload = await request.json()

  // Extract prices from payload.data or top-level
  const prices: MarketPriceData[] = payload.data?.prices ?? payload.prices ?? []
  const source = payload.data?.source ?? payload.source ?? 'yahoo'

  if (prices.length === 0) {
    return jsonResponse({
      success: true,
      message: 'No prices to insert',
      inserted: 0
    })
  }

  let inserted = 0
  let updated = 0
  let errors = 0

  for (const price of prices) {
    try {
      // Validate required fields
      if (!price.ticker || !price.date || price.close === undefined) {
        errors++
        continue
      }

      // Use INSERT OR REPLACE to handle duplicates
      await env.TRADER_DB.prepare(
        `
        INSERT OR REPLACE INTO market_prices
        (ticker, date, open, high, low, close, volume, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
        .bind(
          price.ticker,
          price.date,
          price.open ?? price.close,
          price.high ?? price.close,
          price.low ?? price.close,
          price.close,
          price.volume ?? null,
          price.source || source
        )
        .run()

      inserted++
    } catch (error) {
      console.error(`Error inserting price for ${price.ticker}:`, error)
      errors++
    }
  }

  console.log(`Market prices backfill: ${inserted} inserted/updated, ${errors} errors`)

  return jsonResponse({
    success: true,
    inserted,
    updated,
    errors,
    total_received: prices.length
  })
}

/**
 * GET /market/prices - Get market prices with optional filters
 *
 * Query params:
 * - ticker: single ticker or comma-separated list
 * - start_date: YYYY-MM-DD
 * - end_date: YYYY-MM-DD
 */
export async function handleGetMarketPrices(request: Request, env: TraderEnv): Promise<Response> {
  const url = new URL(request.url)
  const ticker = url.searchParams.get('ticker')
  const startDate = url.searchParams.get('start_date')
  const endDate = url.searchParams.get('end_date')

  let query = 'SELECT * FROM market_prices WHERE 1=1'
  const params: (string | null)[] = []

  if (ticker) {
    const tickers = ticker.split(',').map(t => t.trim())
    if (tickers.length === 1) {
      query += ' AND ticker = ?'
      params.push(tickers[0])
    } else {
      const placeholders = tickers.map(() => '?').join(',')
      query += ` AND ticker IN (${placeholders})`
      params.push(...tickers)
    }
  }

  if (startDate) {
    query += ' AND date >= ?'
    params.push(startDate)
  }

  if (endDate) {
    query += ' AND date <= ?'
    params.push(endDate)
  }

  query += ' ORDER BY ticker, date LIMIT 10000'

  const results = await env.TRADER_DB.prepare(query)
    .bind(...params)
    .all()

  return jsonResponse({
    prices: results.results,
    count: results.results.length
  })
}

/**
 * GET /market/tickers - Get list of unique tickers with price data
 */
export async function handleGetMarketTickers(env: TraderEnv): Promise<Response> {
  const results = await env.TRADER_DB.prepare(
    `
    SELECT
      ticker,
      COUNT(*) as price_count,
      MIN(date) as first_date,
      MAX(date) as last_date
    FROM market_prices
    GROUP BY ticker
    ORDER BY ticker
  `
  ).all()

  return jsonResponse({
    tickers: results.results,
    count: results.results.length
  })
}

/**
 * POST /market/backfill/trigger - Trigger historical price backfill
 *
 * Request body:
 * {
 *   "start_date": "2025-10-01",
 *   "end_date": "2026-01-16",
 *   "tickers": ["NVDA", "AAPL"]  // optional, defaults to all tickers from signals
 * }
 */
export async function handleMarketBackfillTrigger(
  request: Request,
  env: TraderEnv
): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env, 'TRADER_API_KEY')) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
  }

  const body: MarketBackfillTriggerRequest = await request.json()

  const startDate = body.start_date || '2025-10-01'
  const endDate = body.end_date || new Date().toISOString().split('T')[0]
  const tickers = body.tickers

  try {
    const result = await backfillMarketPrices(env, startDate, endDate, tickers)

    return jsonResponse({
      success: true,
      message: `Backfill completed: ${result.inserted} inserted, ${result.errors} errors`,
      ...result,
      start_date: startDate,
      end_date: endDate
    })
  } catch (error) {
    console.error('Backfill error:', error)
    return jsonResponse({ success: false, error: 'Backfill failed' }, 500)
  }
}

// =============================================================================
// Performance Handler
// =============================================================================

export async function handleGetPerformance(env: TraderEnv): Promise<Response> {
  // Fetch performance history (stores % returns directly)
  const history = await env.TRADER_DB.prepare(
    `
    SELECT date, signals_return_pct, hadoku_return_pct, sp500_return_pct
    FROM performance_history
    ORDER BY date ASC
  `
  ).all()

  const data = history.results as any[]

  // Calculate cumulative metrics from daily % returns
  const calcMetrics = (key: string) => {
    if (data.length === 0) {
      return { total_return_pct: 0, mtd_return_pct: 0, ytd_return_pct: 0 }
    }

    // Total return is the latest value (already cumulative)
    const total_return_pct = data.length > 0 ? data[data.length - 1][key] : 0

    // MTD: from start of month
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const mtdData = data.filter(d => new Date(d.date) >= monthStart)
    const mtd_return_pct =
      mtdData.length > 0 ? mtdData[mtdData.length - 1][key] - (mtdData[0][key] || 0) : 0

    // YTD: from start of year
    const yearStart = new Date(now.getFullYear(), 0, 1)
    const ytdData = data.filter(d => new Date(d.date) >= yearStart)
    const ytd_return_pct =
      ytdData.length > 0 ? ytdData[ytdData.length - 1][key] - (ytdData[0][key] || 0) : 0

    return { total_return_pct, mtd_return_pct, ytd_return_pct }
  }

  // Build history arrays for charting (value = % return for that day)
  const signalsHistory = data.map(d => ({
    date: d.date,
    value: d.signals_return_pct
  }))
  const hadokuHistory = data.map(d => ({
    date: d.date,
    value: d.hadoku_return_pct
  }))
  const sp500History = data.map(d => ({
    date: d.date,
    value: d.sp500_return_pct
  }))

  return jsonResponse({
    signals_performance: {
      ...calcMetrics('signals_return_pct'),
      history: signalsHistory
    },
    hadoku_performance: {
      ...calcMetrics('hadoku_return_pct'),
      history: hadokuHistory
    },
    sp500_performance: {
      ...calcMetrics('sp500_return_pct'),
      history: sp500History
    },
    last_updated: new Date().toISOString()
  })
}

// =============================================================================
// Trades Handler
// =============================================================================

export async function handleGetTrades(env: TraderEnv): Promise<Response> {
  const trades = await env.TRADER_DB.prepare(
    `
    SELECT * FROM trades
    ORDER BY executed_at DESC
    LIMIT 100
  `
  ).all()

  const formattedTrades = trades.results.map((t: any) => ({
    id: t.id,
    date: t.executed_at,
    ticker: t.ticker,
    action: t.action,
    quantity: t.quantity,
    price: t.price,
    total: t.total,
    signal_id: t.signal_id,
    reasoning: t.reasoning_json ? JSON.parse(t.reasoning_json) : null,
    status: t.status
  }))

  return jsonResponse({
    trades: formattedTrades,
    last_updated: new Date().toISOString()
  })
}

// =============================================================================
// Sources Handler
// =============================================================================

export async function handleGetSources(env: TraderEnv): Promise<Response> {
  // Get signal counts per source
  const stats = await env.TRADER_DB.prepare(
    `
    SELECT
      source as name,
      COUNT(*) as total_signals,
      SUM(CASE WHEN id IN (SELECT signal_id FROM trades WHERE status = 'executed') THEN 1 ELSE 0 END) as executed_signals
    FROM signals
    GROUP BY source
  `
  ).all()

  // Get trade outcomes per source for calculating returns and win rate
  const tradeOutcomes = await env.TRADER_DB.prepare(
    `
    SELECT
      s.source,
      COUNT(*) as trade_count,
      SUM(CASE WHEN p.close_price > p.entry_price THEN 1 ELSE 0 END) as winning_trades,
      AVG(CASE
        WHEN p.close_price IS NOT NULL AND p.entry_price > 0
        THEN ((p.close_price - p.entry_price) / p.entry_price) * 100
        ELSE NULL
      END) as avg_return_pct
    FROM trades t
    JOIN signals s ON t.signal_id = s.id
    LEFT JOIN positions p ON p.signal_id = s.id
    WHERE t.status = 'executed'
    GROUP BY s.source
  `
  ).all()

  // Build a map of source -> outcomes
  const outcomeMap = new Map<string, { avg_return_pct: number; win_rate: number }>()
  for (const outcome of tradeOutcomes.results as any[]) {
    const winRate = outcome.trade_count > 0 ? outcome.winning_trades / outcome.trade_count : 0
    outcomeMap.set(outcome.source, {
      avg_return_pct: outcome.avg_return_pct ?? 0,
      win_rate: winRate
    })
  }

  // Combine stats with outcomes
  const sources = stats.results.map((s: any) => {
    const outcomes = outcomeMap.get(s.name) ?? { avg_return_pct: 0, win_rate: 0 }
    return {
      name: s.name,
      total_signals: s.total_signals,
      executed_signals: s.executed_signals || 0,
      avg_return_pct: Math.round(outcomes.avg_return_pct * 100) / 100,
      win_rate: Math.round(outcomes.win_rate * 100) / 100
    }
  })

  return jsonResponse({
    sources,
    last_updated: new Date().toISOString()
  })
}

// =============================================================================
// Trade Execution Handler
// =============================================================================

export async function handleExecuteTrade(request: Request, env: TraderEnv): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env, 'TRADER_API_KEY')) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
  }

  const tradeRequest: ExecuteTradeRequest = await request.json()

  // Forward to local trader-worker via tunnel
  try {
    const tunnelResponse = await fetch(`${env.TUNNEL_URL}/execute-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.TRADER_API_KEY
      },
      body: JSON.stringify(tradeRequest)
    })

    const result: ExecuteTradeResponse = await tunnelResponse.json()

    // Log the trade attempt
    if (result.success && !tradeRequest.dry_run) {
      await env.TRADER_DB.prepare(
        `
        INSERT INTO trades (id, ticker, action, quantity, price, total, status, executed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
        .bind(
          generateId('trade'),
          tradeRequest.ticker,
          tradeRequest.action,
          tradeRequest.quantity,
          result.details?.price || 0,
          ((result.details?.price as number) || 0) * tradeRequest.quantity,
          'executed',
          new Date().toISOString()
        )
        .run()
    }

    return jsonResponse(result)
  } catch (error) {
    console.error('Tunnel error:', error)
    return jsonResponse(
      {
        success: false,
        message: 'Failed to connect to trade execution service'
      },
      503
    )
  }
}

// =============================================================================
// Health Handler
// =============================================================================

export async function handleHealth(env: TraderEnv): Promise<Response> {
  // Debug: log env keys to diagnose missing bindings
  console.log('[health] env keys:', Object.keys(env))
  console.log('[health] TRADER_API_KEY exists:', !!env.TRADER_API_KEY)
  console.log('[health] TUNNEL_URL:', env.TUNNEL_URL)

  // Check DB connection
  let dbOk = false
  try {
    await env.TRADER_DB.prepare('SELECT 1').first()
    dbOk = true
  } catch {
    dbOk = false
  }

  // Check tunnel connectivity
  let tunnelOk = false
  if (!env.TRADER_API_KEY) {
    console.error('[health] TRADER_API_KEY is missing from env! Add it to wrangler.toml secrets.')
  }
  try {
    const resp = await fetch(`${env.TUNNEL_URL}/health`, {
      method: 'GET',
      headers: {
        'X-User-Key': getAdminKey(env),
        'X-API-Key': env.TRADER_API_KEY || ''
      },
      signal: AbortSignal.timeout(5000)
    })
    tunnelOk = resp.ok
  } catch {
    tunnelOk = false
  }

  return jsonResponse({
    status: dbOk && tunnelOk ? 'healthy' : 'degraded',
    database: dbOk ? 'connected' : 'disconnected',
    trader_worker: tunnelOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  })
}

// =============================================================================
// Agent Handlers
// =============================================================================

/**
 * Calculate total return percentage from an array of positions.
 * Each position should have cost_basis, current_price, and quantity fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function calculatePositionsReturnPct(positions: any[]): number {
  let totalCostBasis = 0
  let totalCurrentValue = 0
  for (const pos of positions) {
    totalCostBasis += (pos.cost_basis as number) || 0
    totalCurrentValue += ((pos.current_price as number) || 0) * ((pos.quantity as number) || 0)
  }
  return totalCostBasis > 0 ? ((totalCurrentValue - totalCostBasis) / totalCostBasis) * 100 : 0
}

/**
 * GET /agents - List all agents with budget status
 */
export async function handleGetAgents(env: TraderEnv): Promise<Response> {
  try {
    const agents = await getActiveAgents(env)

    const agentSummaries = await Promise.all(
      agents.map(async agent => {
        const budget = await getAgentBudget(env, agent.id)
        const positions = await getAgentPositions(env, agent.id)

        const totalReturnPct = calculatePositionsReturnPct(positions)

        return {
          id: agent.id,
          name: agent.name,
          is_active: true,
          monthly_budget: budget.total,
          budget_spent: budget.spent,
          budget_remaining: budget.remaining,
          positions_count: positions.length,
          total_return_pct: Math.round(totalReturnPct * 100) / 100
        }
      })
    )

    return jsonResponse({
      agents: agentSummaries,
      last_updated: new Date().toISOString()
    })
  } catch (error) {
    console.error('Error fetching agents:', error)
    return jsonResponse({ success: false, error: 'Failed to fetch agents' }, 500)
  }
}

/**
 * GET /agents/:id - Get agent detail with config and positions
 */
export async function handleGetAgentById(env: TraderEnv, agentId: string): Promise<Response> {
  try {
    const agent = await getAgent(env, agentId)
    if (!agent) {
      return jsonResponse({ success: false, error: 'Agent not found' }, 404)
    }

    const budget = await getAgentBudget(env, agentId)
    const positions = await getAgentPositions(env, agentId)

    // Get recent trades for this agent
    const tradesResult = await env.TRADER_DB.prepare(
      `
      SELECT * FROM trades
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `
    )
      .bind(agentId)
      .all()

    const totalReturnPct = calculatePositionsReturnPct(positions)

    // Format positions for response
    const formattedPositions = positions.map((pos: any) => {
      const entryPrice = pos.avg_cost || pos.entry_price || 0
      const currentPrice = pos.current_price || entryPrice
      const returnPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0
      const daysHeld = pos.entry_date ? daysBetween(pos.entry_date, getCurrentDate()) : 0

      return {
        ticker: pos.ticker,
        shares: pos.quantity,
        entry_price: entryPrice,
        current_price: currentPrice,
        cost_basis: pos.cost_basis || entryPrice * pos.quantity,
        return_pct: Math.round(returnPct * 100) / 100,
        days_held: daysHeld
      }
    })

    // Format trades for response
    const formattedTrades = tradesResult.results.map((t: any) => ({
      id: t.id,
      signal_id: t.signal_id,
      ticker: t.ticker,
      action: t.action,
      decision: t.decision,
      score: t.score,
      position_size: t.total,
      executed_at: t.executed_at
    }))

    return jsonResponse({
      agent: {
        id: agent.id,
        name: agent.name,
        is_active: true,
        monthly_budget: budget.total,
        budget_spent: budget.spent,
        budget_remaining: budget.remaining,
        positions_count: positions.length,
        total_return_pct: Math.round(totalReturnPct * 100) / 100
      },
      config: agent,
      positions: formattedPositions,
      recent_trades: formattedTrades
    })
  } catch (error) {
    console.error('Error fetching agent:', error)
    return jsonResponse({ success: false, error: 'Failed to fetch agent' }, 500)
  }
}

/**
 * GET /agents/configs - Get canonical agent configurations from code
 *
 * Returns the authoritative agent configs defined in configs.ts.
 * hadoku-site should use these configs instead of storing its own copy.
 * This ensures a single source of truth for thresholds, sizing, etc.
 */
export function handleGetAgentConfigs(): Response {
  return jsonResponse({
    configs: AGENT_CONFIGS,
    trading_agents: TRADING_AGENTS.map(a => a.id),
    last_updated: new Date().toISOString()
  })
}

/**
 * GET /agents/configs/:id - Get a specific agent's canonical config
 */
export function handleGetAgentConfigById(agentId: string): Response {
  const config = AGENT_CONFIGS[agentId]
  if (!config) {
    return jsonResponse({ success: false, error: 'Agent config not found' }, 404)
  }
  return jsonResponse({ config })
}

/**
 * POST /signals/process - Manually trigger signal processing
 */
export async function handleProcessSignals(request: Request, env: TraderEnv): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env, 'TRADER_API_KEY')) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const result = await processAllPendingSignals(env)

    return jsonResponse({
      success: true,
      ...result
    })
  } catch (error) {
    console.error('Error processing signals:', error)
    return jsonResponse({ success: false, error: 'Failed to process signals' }, 500)
  }
}

// =============================================================================
// Simulation Handler
// =============================================================================

interface SimulateRequest {
  signals: {
    id: string
    source: string
    politician_name: string
    politician_chamber?: string
    politician_party?: string
    politician_state?: string
    ticker: string
    action: 'buy' | 'sell'
    asset_type?: string
    position_size_min?: number
    trade_date: string
    trade_price: number
    disclosure_date: string
    disclosure_price: number | null
  }[]
  budget?: number
  agents?: string[]
}

// ScoringBreakdown is imported from ./agents

interface SimulationDecision {
  signal_id: string
  ticker: string
  politician: string
  action: string
  days_since_trade: number
  price_change_pct: number
  score: number | null
  score_breakdown: ScoringBreakdown | null
  decision: 'execute' | 'skip'
  position_size: number | null
  reason: string
}

interface SimulationAgentResult {
  id: string
  name: string
  decisions: SimulationDecision[]
  summary: {
    total_signals: number
    executed: number
    skipped: number
    total_invested: number
    cash_remaining: number
    open_positions: number
  }
}

// getDetailedScoring is imported from ./agents/scoring.ts

/**
 * Wrapper for production calculatePositionSize for simulation context.
 * Uses the same sizing logic as production to ensure consistency.
 */
function calculateSimPositionSize(
  config: AgentConfig,
  score: number,
  availableCash: number
): number {
  return calculatePositionSize(
    config,
    score,
    { remaining: availableCash },
    1, // acceptedSignalsCount
    false, // isHalfSize
    undefined, // congressionalPositionSize
    undefined // availableCapital (use monthly_budget)
  )
}

function runAgentSimulation(
  config: AgentConfig,
  signals: SimulateRequest['signals'],
  budget: number
): SimulationAgentResult {
  const sortedSignals = [...signals].sort((a, b) =>
    a.disclosure_date.localeCompare(b.disclosure_date)
  )

  const validSignals = sortedSignals.filter(s => s.disclosure_price && s.disclosure_price > 0)

  // Compute politician "disclosure lag win rates"
  // A "win" = price went up between trade_date and disclosure_date
  // This measures the politician's timing skill: did they buy before a price increase?
  //
  // Price semantics:
  // - trade_price: What they paid (price on trade_date)
  // - disclosure_price: Price when trade became public (on disclosure_date)
  //
  // This metric captures the "edge" they had during the disclosure lag period,
  // which is typically 15-45 days where they know something the market doesn't.
  const winRateStats = new Map<string, { wins: number; total: number }>()
  for (const signal of validSignals) {
    if (signal.action !== 'buy') continue
    const existing = winRateStats.get(signal.politician_name) || { wins: 0, total: 0 }
    existing.total++
    // Win if disclosure_price > trade_price (price went up during disclosure lag)
    if (signal.disclosure_price! > signal.trade_price) {
      existing.wins++
    }
    winRateStats.set(signal.politician_name, existing)
  }
  const politicianWinRates = new Map<string, number>()
  for (const [name, { wins, total }] of winRateStats) {
    politicianWinRates.set(name, total > 0 ? wins / total : 0.5)
  }

  let cash = budget
  const decisions: SimulationDecision[] = []
  let openPositions = 0
  let totalInvested = 0

  for (const simSignal of validSignals) {
    const currentPrice = simSignal.disclosure_price!
    const tradePrice = simSignal.trade_price ?? currentPrice
    const daysSinceTrade = daysBetween(simSignal.trade_date, simSignal.disclosure_date)
    const priceChangePct = tradePrice > 0 ? ((currentPrice - tradePrice) / tradePrice) * 100 : 0

    let decision: 'execute' | 'skip' = 'skip'
    let reason = ''
    let score: number | null = null
    let breakdown: ScoringBreakdown | null = null
    let positionSize: number | null = null

    if (simSignal.action === 'sell') {
      reason = 'Sell signal (simulation only tracks buys)'
    } else if (
      config.politician_whitelist &&
      !config.politician_whitelist.includes(simSignal.politician_name)
    ) {
      reason = 'Not in politician whitelist'
    } else if (
      simSignal.asset_type &&
      !config.allowed_asset_types.includes(simSignal.asset_type as any)
    ) {
      reason = `Asset type ${simSignal.asset_type} not allowed`
    } else if (daysSinceTrade > config.max_signal_age_days) {
      reason = `Too old (${daysSinceTrade}d > ${config.max_signal_age_days}d)`
    } else if (Math.abs(priceChangePct) > config.max_price_move_pct) {
      reason = `Price moved ${Math.abs(priceChangePct).toFixed(1)}% > ${config.max_price_move_pct}%`
    } else if (config.scoring) {
      // In simulation, currentPrice = disclosure_price (we evaluate at disclosure time)
      // disclosure_drift_pct = 0 since current = disclosure price
      const enrichedSignal: EnrichedSignal = {
        id: simSignal.id,
        ticker: simSignal.ticker,
        action: simSignal.action,
        asset_type: (simSignal.asset_type || 'stock') as any,
        trade_price: tradePrice,
        disclosure_price: simSignal.disclosure_price ?? null,
        current_price: currentPrice,
        trade_date: simSignal.trade_date,
        disclosure_date: simSignal.disclosure_date,
        position_size_min: simSignal.position_size_min || 0,
        politician_name: simSignal.politician_name,
        source: simSignal.source,
        days_since_trade: daysSinceTrade,
        days_since_filing: 0, // At disclosure time, filing just happened
        price_change_pct: priceChangePct,
        disclosure_drift_pct: 0 // At disclosure time, no drift yet
      }

      const winRate = politicianWinRates.get(simSignal.politician_name) ?? 0.5
      const scoreResult = calculateScoreSync(config.scoring, enrichedSignal, winRate)
      score = scoreResult.score
      breakdown = getDetailedScoring(config.scoring, enrichedSignal, winRate)

      if (score < config.execute_threshold) {
        reason = `Score ${score.toFixed(3)} < threshold ${config.execute_threshold}`
      } else {
        const size = calculateSimPositionSize(config, score, cash)
        if (size < 1) {
          reason = `Position size too small ($${size.toFixed(2)})`
        } else if (size > cash) {
          reason = `Insufficient cash ($${size.toFixed(0)} > $${cash.toFixed(0)})`
        } else {
          decision = 'execute'
          positionSize = size
          cash -= size
          openPositions++
          totalInvested += size
          reason = `Executed @ $${currentPrice.toFixed(2)}`
        }
      }
    } else {
      // No scoring (Gemini-style)
      const size = calculateSimPositionSize(config, 1.0, cash)
      if (size < 1) {
        reason = 'Position size too small'
      } else if (size > cash) {
        reason = 'Insufficient cash'
      } else {
        decision = 'execute'
        positionSize = size
        cash -= size
        openPositions++
        totalInvested += size
        reason = `Executed @ $${currentPrice.toFixed(2)}`
      }
    }

    decisions.push({
      signal_id: simSignal.id,
      ticker: simSignal.ticker,
      politician: simSignal.politician_name,
      action: simSignal.action,
      days_since_trade: daysSinceTrade,
      price_change_pct: Math.round(priceChangePct * 100) / 100,
      score,
      score_breakdown: breakdown,
      decision,
      position_size: positionSize,
      reason
    })
  }

  const executed = decisions.filter(d => d.decision === 'execute').length
  const skipped = decisions.filter(d => d.decision === 'skip').length

  return {
    id: config.id,
    name: config.name,
    decisions,
    summary: {
      total_signals: validSignals.length,
      executed,
      skipped,
      total_invested: Math.round(totalInvested * 100) / 100,
      cash_remaining: Math.round(cash * 100) / 100,
      open_positions: openPositions
    }
  }
}

/**
 * POST /simulate - Run simulation on signals without executing trades
 *
 * This endpoint runs the full scoring and decision pipeline without
 * actually executing any trades. Useful for testing and verification.
 */
export async function handleSimulateSignals(request: Request, env: TraderEnv): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env, 'TRADER_API_KEY')) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const payload: SimulateRequest = await request.json()
    const budget = payload.budget ?? 1000
    const requestedAgents = payload.agents ?? ['chatgpt']

    const results: SimulationAgentResult[] = []

    for (const agentId of requestedAgents) {
      const config = AGENT_CONFIGS[agentId]
      if (!config) {
        continue
      }
      const result = runAgentSimulation(config, payload.signals, budget)
      results.push(result)
    }

    return jsonResponse({
      success: true,
      simulation_date: new Date().toISOString(),
      budget,
      agents: results
    })
  } catch (error) {
    console.error('Error running simulation:', error)
    return jsonResponse({ success: false, error: 'Failed to run simulation' }, 500)
  }
}
