/**
 * Individual route handlers for the trader worker.
 * These can be used directly or through createTraderHandler.
 */

import {
  TraderEnv,
  Signal,
  ExecuteTradeRequest,
  ExecuteTradeResponse,
} from "./types";
import { jsonResponse, verifyApiKey, generateId } from "./utils";
import {
  getActiveAgents,
  getAgent,
  getAgentBudget,
  getAgentPositions,
  processAllPendingSignals,
  getCurrentMonth,
} from "./agents";

// =============================================================================
// Signal Handlers
// =============================================================================

export async function handleGetSignals(env: TraderEnv): Promise<Response> {
  const results = await env.TRADER_DB.prepare(`
    SELECT * FROM signals
    ORDER BY scraped_at DESC
    LIMIT 100
  `).all();

  const signals = results.results.map((row: any) => ({
    id: row.id,
    source: row.source,
    politician: {
      name: row.politician_name,
      chamber: row.politician_chamber,
      party: row.politician_party,
      state: row.politician_state,
    },
    trade: {
      ticker: row.ticker,
      action: row.action,
      asset_type: row.asset_type,
      disclosed_price: row.disclosed_price,
      disclosed_date: row.disclosed_date,
      filing_date: row.filing_date,
      position_size: row.position_size,
      position_size_min: row.position_size_min,
      position_size_max: row.position_size_max,
    },
    meta: {
      source_url: row.source_url,
      source_id: row.source_id,
      scraped_at: row.scraped_at,
    },
  }));

  return jsonResponse({
    signals,
    last_updated: new Date().toISOString(),
  });
}

export async function handlePostSignal(
  request: Request,
  env: TraderEnv
): Promise<Response> {
  // Verify API key from scraper
  if (!verifyApiKey(request, env, "SCRAPER_API_KEY")) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  const signal: Signal = await request.json();

  // Check for duplicate
  const existing = await env.TRADER_DB.prepare(
    "SELECT id FROM signals WHERE source = ? AND source_id = ?"
  )
    .bind(signal.source, signal.meta.source_id)
    .first();

  if (existing) {
    return jsonResponse({
      success: true,
      message: "Signal already exists",
      id: existing.id,
      duplicate: true,
    });
  }

  // Insert new signal
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

  return jsonResponse({
    success: true,
    message: "Signal received",
    id,
  });
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
export async function handleBackfillBatch(
  request: Request,
  env: TraderEnv
): Promise<Response> {
  // Verify API key from scraper
  if (!verifyApiKey(request, env, "SCRAPER_API_KEY")) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  const payload = await request.json() as {
    event: string;
    job_id?: string;
    batch_number?: number;
    source?: string;
    signals?: Signal[];
    data?: {
      signals?: Signal[];
      job_id?: string;
      batch_number?: number;
      source?: string;
    };
    is_last_batch?: boolean;
  };

  // Extract fields from either payload.data or top-level (scraper uses payload.data)
  const jobId = payload.data?.job_id ?? payload.job_id;
  const batchNumber = payload.data?.batch_number ?? payload.batch_number;
  const source = payload.data?.source ?? payload.source;

  // Validate event type
  if (payload.event !== "backfill.batch" && payload.event !== "backfill.completed") {
    return jsonResponse({
      success: true,
      message: `Ignored event: ${payload.event}`,
    });
  }

  // Handle completion event
  if (payload.event === "backfill.completed") {
    console.log(`Backfill job ${jobId} completed`);
    return jsonResponse({
      success: true,
      message: "Backfill completed acknowledged",
      job_id: jobId,
    });
  }

  // Process batch of signals (support both payload.data.signals and payload.signals)
  const signals = payload.data?.signals || payload.signals || [];
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;

  for (const signal of signals) {
    try {
      // Check for duplicate (D1 requires null, not undefined)
      const sourceId = signal.meta?.source_id ?? null;
      const existing = await env.TRADER_DB.prepare(
        "SELECT id FROM signals WHERE source = ? AND source_id = ?"
      )
        .bind(signal.source ?? null, sourceId)
        .first();

      if (existing) {
        duplicates++;
        continue;
      }

      // Insert new signal - use defaults for NOT NULL columns, null for nullable
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
          signal.source ?? null,
          signal.politician?.name ?? null,
          signal.politician?.chamber ?? null,
          signal.politician?.party ?? "unknown",      // NOT NULL - default
          signal.politician?.state ?? "unknown",      // NOT NULL - default
          signal.trade?.ticker ?? null,
          signal.trade?.action ?? null,
          signal.trade?.asset_type ?? null,
          signal.trade?.disclosed_price ?? null,
          signal.trade?.price_at_filing ?? null,
          signal.trade?.disclosed_date ?? null,
          signal.trade?.filing_date ?? "",            // NOT NULL - default
          signal.trade?.position_size ?? "",          // NOT NULL - default
          signal.trade?.position_size_min ?? 0,       // NOT NULL - default
          signal.trade?.position_size_max ?? 0,       // NOT NULL - default
          signal.trade?.option_type ?? null,
          signal.trade?.strike_price ?? null,
          signal.trade?.expiration_date ?? null,
          signal.meta?.source_url ?? "",              // NOT NULL - default
          signal.meta?.source_id ?? null,
          signal.meta?.scraped_at ?? null
        )
        .run();

      inserted++;
    } catch (error) {
      console.error("Error inserting signal:", error);
      errors++;
    }
  }

  console.log(
    `Backfill batch ${batchNumber} from ${source}: ` +
    `${inserted} inserted, ${duplicates} duplicates, ${errors} errors`
  );

  return jsonResponse({
    success: true,
    job_id: jobId,
    batch_number: batchNumber,
    inserted,
    duplicates,
    errors,
    total_received: signals.length,
  });
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
  if (!verifyApiKey(request, env, "SCRAPER_API_KEY")) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  interface PriceData {
    ticker: string;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    source?: string;
  }

  const payload = await request.json() as {
    event?: string;
    data?: {
      prices?: PriceData[];
      source?: string;
    };
    prices?: PriceData[];
    source?: string;
  };

  // Extract prices from payload.data or top-level
  const prices = payload.data?.prices || payload.prices || [];
  const source = payload.data?.source || payload.source || "yahoo";

  if (prices.length === 0) {
    return jsonResponse({
      success: true,
      message: "No prices to insert",
      inserted: 0,
    });
  }

  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const price of prices) {
    try {
      // Validate required fields
      if (!price.ticker || !price.date || price.close === undefined) {
        errors++;
        continue;
      }

      // Use INSERT OR REPLACE to handle duplicates
      await env.TRADER_DB.prepare(`
        INSERT OR REPLACE INTO market_prices
        (ticker, date, open, high, low, close, volume, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
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
        .run();

      inserted++;
    } catch (error) {
      console.error(`Error inserting price for ${price.ticker}:`, error);
      errors++;
    }
  }

  console.log(
    `Market prices backfill: ${inserted} inserted/updated, ${errors} errors`
  );

  return jsonResponse({
    success: true,
    inserted,
    updated,
    errors,
    total_received: prices.length,
  });
}

/**
 * GET /market/prices - Get market prices with optional filters
 *
 * Query params:
 * - ticker: single ticker or comma-separated list
 * - start_date: YYYY-MM-DD
 * - end_date: YYYY-MM-DD
 */
export async function handleGetMarketPrices(
  request: Request,
  env: TraderEnv
): Promise<Response> {
  const url = new URL(request.url);
  const ticker = url.searchParams.get("ticker");
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");

  let query = "SELECT * FROM market_prices WHERE 1=1";
  const params: (string | null)[] = [];

  if (ticker) {
    const tickers = ticker.split(",").map((t) => t.trim());
    if (tickers.length === 1) {
      query += " AND ticker = ?";
      params.push(tickers[0]);
    } else {
      const placeholders = tickers.map(() => "?").join(",");
      query += ` AND ticker IN (${placeholders})`;
      params.push(...tickers);
    }
  }

  if (startDate) {
    query += " AND date >= ?";
    params.push(startDate);
  }

  if (endDate) {
    query += " AND date <= ?";
    params.push(endDate);
  }

  query += " ORDER BY ticker, date LIMIT 10000";

  const results = await env.TRADER_DB.prepare(query).bind(...params).all();

  return jsonResponse({
    prices: results.results,
    count: results.results.length,
  });
}

/**
 * GET /market/tickers - Get list of unique tickers with price data
 */
export async function handleGetMarketTickers(env: TraderEnv): Promise<Response> {
  const results = await env.TRADER_DB.prepare(`
    SELECT
      ticker,
      COUNT(*) as price_count,
      MIN(date) as first_date,
      MAX(date) as last_date
    FROM market_prices
    GROUP BY ticker
    ORDER BY ticker
  `).all();

  return jsonResponse({
    tickers: results.results,
    count: results.results.length,
  });
}

// =============================================================================
// Performance Handler
// =============================================================================

export async function handleGetPerformance(env: TraderEnv): Promise<Response> {
  // Fetch performance history (stores % returns directly)
  const history = await env.TRADER_DB.prepare(`
    SELECT date, signals_return_pct, hadoku_return_pct, sp500_return_pct
    FROM performance_history
    ORDER BY date ASC
  `).all();

  const data = history.results as any[];

  // Calculate cumulative metrics from daily % returns
  const calcMetrics = (key: string) => {
    if (data.length === 0) {
      return { total_return_pct: 0, mtd_return_pct: 0, ytd_return_pct: 0 };
    }

    // Total return is the latest value (already cumulative)
    const total_return_pct = data.length > 0 ? data[data.length - 1][key] : 0;

    // MTD: from start of month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const mtdData = data.filter((d) => new Date(d.date) >= monthStart);
    const mtd_return_pct = mtdData.length > 0 ? mtdData[mtdData.length - 1][key] - (mtdData[0][key] || 0) : 0;

    // YTD: from start of year
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const ytdData = data.filter((d) => new Date(d.date) >= yearStart);
    const ytd_return_pct = ytdData.length > 0 ? ytdData[ytdData.length - 1][key] - (ytdData[0][key] || 0) : 0;

    return { total_return_pct, mtd_return_pct, ytd_return_pct };
  };

  // Build history arrays for charting (value = % return for that day)
  const signalsHistory = data.map((d) => ({
    date: d.date,
    value: d.signals_return_pct,
  }));
  const hadokuHistory = data.map((d) => ({
    date: d.date,
    value: d.hadoku_return_pct,
  }));
  const sp500History = data.map((d) => ({
    date: d.date,
    value: d.sp500_return_pct,
  }));

  return jsonResponse({
    signals_performance: {
      ...calcMetrics("signals_return_pct"),
      history: signalsHistory,
    },
    hadoku_performance: {
      ...calcMetrics("hadoku_return_pct"),
      history: hadokuHistory,
    },
    sp500_performance: {
      ...calcMetrics("sp500_return_pct"),
      history: sp500History,
    },
    last_updated: new Date().toISOString(),
  });
}

// =============================================================================
// Trades Handler
// =============================================================================

export async function handleGetTrades(env: TraderEnv): Promise<Response> {
  const trades = await env.TRADER_DB.prepare(`
    SELECT * FROM trades
    ORDER BY executed_at DESC
    LIMIT 100
  `).all();

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
    status: t.status,
  }));

  return jsonResponse({
    trades: formattedTrades,
    last_updated: new Date().toISOString(),
  });
}

// =============================================================================
// Sources Handler
// =============================================================================

export async function handleGetSources(env: TraderEnv): Promise<Response> {
  const stats = await env.TRADER_DB.prepare(`
    SELECT
      source as name,
      COUNT(*) as total_signals,
      SUM(CASE WHEN id IN (SELECT signal_id FROM trades WHERE status = 'executed') THEN 1 ELSE 0 END) as executed_signals
    FROM signals
    GROUP BY source
  `).all();

  // Calculate returns per source (simplified - would need trade outcome data)
  const sources = stats.results.map((s: any) => ({
    name: s.name,
    total_signals: s.total_signals,
    executed_signals: s.executed_signals || 0,
    avg_return_pct: 0, // TODO: Calculate from trade outcomes
    win_rate: 0, // TODO: Calculate from trade outcomes
  }));

  return jsonResponse({
    sources,
    last_updated: new Date().toISOString(),
  });
}

// =============================================================================
// Trade Execution Handler
// =============================================================================

export async function handleExecuteTrade(
  request: Request,
  env: TraderEnv
): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env, "TRADER_API_KEY")) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  const tradeRequest: ExecuteTradeRequest = await request.json();

  // Forward to local trader-worker via tunnel
  try {
    const tunnelResponse = await fetch(`${env.TUNNEL_URL}/execute-trade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": env.TRADER_API_KEY,
      },
      body: JSON.stringify(tradeRequest),
    });

    const result: ExecuteTradeResponse = await tunnelResponse.json();

    // Log the trade attempt
    if (result.success && !tradeRequest.dry_run) {
      await env.TRADER_DB.prepare(`
        INSERT INTO trades (id, ticker, action, quantity, price, total, status, executed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          generateId("trade"),
          tradeRequest.ticker,
          tradeRequest.action,
          tradeRequest.quantity,
          result.details?.price || 0,
          ((result.details?.price as number) || 0) * tradeRequest.quantity,
          "executed",
          new Date().toISOString()
        )
        .run();
    }

    return jsonResponse(result);
  } catch (error) {
    console.error("Tunnel error:", error);
    return jsonResponse(
      {
        success: false,
        message: "Failed to connect to trade execution service",
      },
      503
    );
  }
}

// =============================================================================
// Health Handler
// =============================================================================

export async function handleHealth(env: TraderEnv): Promise<Response> {
  // Check DB connection
  let dbOk = false;
  try {
    await env.TRADER_DB.prepare("SELECT 1").first();
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // Check tunnel connectivity
  let tunnelOk = false;
  try {
    const resp = await fetch(`${env.TUNNEL_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    tunnelOk = resp.ok;
  } catch {
    tunnelOk = false;
  }

  return jsonResponse({
    status: dbOk && tunnelOk ? "healthy" : "degraded",
    database: dbOk ? "connected" : "disconnected",
    trader_worker: tunnelOk ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
}

// =============================================================================
// Agent Handlers
// =============================================================================

/**
 * GET /agents - List all agents with budget status
 */
export async function handleGetAgents(env: TraderEnv): Promise<Response> {
  try {
    const agents = await getActiveAgents(env);
    const month = getCurrentMonth();

    const agentSummaries = await Promise.all(
      agents.map(async (agent) => {
        const budget = await getAgentBudget(env, agent.id);
        const positions = await getAgentPositions(env, agent.id);

        // Calculate total return
        let totalCostBasis = 0;
        let totalCurrentValue = 0;
        for (const pos of positions) {
          totalCostBasis += (pos.cost_basis as number) || 0;
          totalCurrentValue +=
            ((pos.current_price as number) || 0) * ((pos.quantity as number) || 0);
        }
        const totalReturnPct =
          totalCostBasis > 0
            ? ((totalCurrentValue - totalCostBasis) / totalCostBasis) * 100
            : 0;

        return {
          id: agent.id,
          name: agent.name,
          is_active: true,
          monthly_budget: budget.total,
          budget_spent: budget.spent,
          budget_remaining: budget.remaining,
          positions_count: positions.length,
          total_return_pct: Math.round(totalReturnPct * 100) / 100,
        };
      })
    );

    return jsonResponse({
      agents: agentSummaries,
      last_updated: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching agents:", error);
    return jsonResponse(
      { success: false, error: "Failed to fetch agents" },
      500
    );
  }
}

/**
 * GET /agents/:id - Get agent detail with config and positions
 */
export async function handleGetAgentById(
  env: TraderEnv,
  agentId: string
): Promise<Response> {
  try {
    const agent = await getAgent(env, agentId);
    if (!agent) {
      return jsonResponse({ success: false, error: "Agent not found" }, 404);
    }

    const budget = await getAgentBudget(env, agentId);
    const positions = await getAgentPositions(env, agentId);

    // Get recent trades for this agent
    const tradesResult = await env.TRADER_DB.prepare(`
      SELECT * FROM trades
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `)
      .bind(agentId)
      .all();

    // Calculate total return
    let totalCostBasis = 0;
    let totalCurrentValue = 0;
    for (const pos of positions) {
      totalCostBasis += (pos.cost_basis as number) || 0;
      totalCurrentValue +=
        ((pos.current_price as number) || 0) * ((pos.quantity as number) || 0);
    }
    const totalReturnPct =
      totalCostBasis > 0
        ? ((totalCurrentValue - totalCostBasis) / totalCostBasis) * 100
        : 0;

    // Format positions for response
    const formattedPositions = positions.map((pos: any) => {
      const entryPrice = pos.avg_cost || pos.entry_price || 0;
      const currentPrice = pos.current_price || entryPrice;
      const returnPct =
        entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
      const daysHeld = pos.entry_date
        ? Math.floor(
            (Date.now() - new Date(pos.entry_date).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

      return {
        ticker: pos.ticker,
        shares: pos.quantity,
        entry_price: entryPrice,
        current_price: currentPrice,
        cost_basis: pos.cost_basis || entryPrice * pos.quantity,
        return_pct: Math.round(returnPct * 100) / 100,
        days_held: daysHeld,
      };
    });

    // Format trades for response
    const formattedTrades = tradesResult.results.map((t: any) => ({
      id: t.id,
      signal_id: t.signal_id,
      ticker: t.ticker,
      action: t.action,
      decision: t.decision,
      score: t.score,
      position_size: t.total,
      executed_at: t.executed_at,
    }));

    return jsonResponse({
      agent: {
        id: agent.id,
        name: agent.name,
        is_active: true,
        monthly_budget: budget.total,
        budget_spent: budget.spent,
        budget_remaining: budget.remaining,
        positions_count: positions.length,
        total_return_pct: Math.round(totalReturnPct * 100) / 100,
      },
      config: agent,
      positions: formattedPositions,
      recent_trades: formattedTrades,
    });
  } catch (error) {
    console.error("Error fetching agent:", error);
    return jsonResponse(
      { success: false, error: "Failed to fetch agent" },
      500
    );
  }
}

/**
 * POST /signals/process - Manually trigger signal processing
 */
export async function handleProcessSignals(
  request: Request,
  env: TraderEnv
): Promise<Response> {
  // Verify API key
  if (!verifyApiKey(request, env, "TRADER_API_KEY")) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  try {
    const result = await processAllPendingSignals(env);

    return jsonResponse({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Error processing signals:", error);
    return jsonResponse(
      { success: false, error: "Failed to process signals" },
      500
    );
  }
}
