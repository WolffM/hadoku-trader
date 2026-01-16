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

  return jsonResponse({
    success: true,
    message: "Signal received",
    id,
  });
}

// =============================================================================
// Performance Handler
// =============================================================================

export async function handleGetPerformance(env: TraderEnv): Promise<Response> {
  const history = await env.TRADER_DB.prepare(`
    SELECT date, signals_value, portfolio_value, sp500_value
    FROM performance_history
    ORDER BY date ASC
  `).all();

  const data = history.results as any[];

  // Calculate metrics
  const calcMetrics = (values: number[], key: string) => {
    if (values.length < 2) {
      return { total_return_pct: 0, mtd_return_pct: 0, ytd_return_pct: 0 };
    }
    const first = values[0];
    const last = values[values.length - 1];
    const total_return_pct = ((last - first) / first) * 100;

    // MTD: from start of month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const mtdData = data.filter((d) => new Date(d.date) >= monthStart);
    const mtdValues = mtdData.map((d) => d[key]);
    const mtd_return_pct =
      mtdValues.length > 1
        ? ((mtdValues[mtdValues.length - 1] - mtdValues[0]) / mtdValues[0]) * 100
        : 0;

    // YTD: from start of year
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const ytdData = data.filter((d) => new Date(d.date) >= yearStart);
    const ytdValues = ytdData.map((d) => d[key]);
    const ytd_return_pct =
      ytdValues.length > 1
        ? ((ytdValues[ytdValues.length - 1] - ytdValues[0]) / ytdValues[0]) * 100
        : 0;

    return { total_return_pct, mtd_return_pct, ytd_return_pct };
  };

  const signalsHistory = data.map((d) => ({
    date: d.date,
    value: d.signals_value,
  }));
  const portfolioHistory = data.map((d) => ({
    date: d.date,
    value: d.portfolio_value,
  }));
  const sp500History = data.map((d) => ({
    date: d.date,
    value: d.sp500_value,
  }));

  return jsonResponse({
    signals_performance: {
      ...calcMetrics(
        data.map((d) => d.signals_value),
        "signals_value"
      ),
      history: signalsHistory,
    },
    portfolio_performance: {
      ...calcMetrics(
        data.map((d) => d.portfolio_value),
        "portfolio_value"
      ),
      history: portfolioHistory,
    },
    sp500_performance: {
      ...calcMetrics(
        data.map((d) => d.sp500_value),
        "sp500_value"
      ),
      history: sp500History,
    },
    last_updated: new Date().toISOString(),
  });
}

// =============================================================================
// Portfolio Handler
// =============================================================================

export async function handleGetPortfolio(env: TraderEnv): Promise<Response> {
  const positions = await env.TRADER_DB.prepare(`
    SELECT * FROM positions WHERE quantity > 0
  `).all();

  // Get current prices (in production, fetch from market data API)
  const positionsWithPrices = positions.results.map((p: any) => {
    const current_price = p.current_price || p.avg_cost;
    const market_value = p.quantity * current_price;
    const cost_basis = p.quantity * p.avg_cost;
    const unrealized_pnl = market_value - cost_basis;
    const unrealized_pnl_pct =
      cost_basis > 0 ? (unrealized_pnl / cost_basis) * 100 : 0;

    return {
      ticker: p.ticker,
      quantity: p.quantity,
      avg_cost: p.avg_cost,
      current_price,
      market_value,
      unrealized_pnl,
      unrealized_pnl_pct,
    };
  });

  const cash = await env.TRADER_DB.prepare(
    "SELECT value FROM config WHERE key = 'cash_balance'"
  ).first();
  const cashBalance = cash?.value ? parseFloat(cash.value as string) : 0;
  const totalValue =
    positionsWithPrices.reduce((sum, p) => sum + p.market_value, 0) +
    cashBalance;

  return jsonResponse({
    positions: positionsWithPrices,
    cash: cashBalance,
    total_value: totalValue,
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
