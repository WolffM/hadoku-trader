/**
 * Hadoku Trader - Cloudflare Worker API
 *
 * This worker handles:
 * 1. Signal ingestion from hadoku-scraper
 * 2. REST API for the dashboard
 * 3. Trade execution proxy to local trader-worker
 *
 * Export this to hadoku-site as a route handler.
 */

import {
  Env,
  Signal,
  ApiResponse,
  ExecuteTradeRequest,
  ExecuteTradeResponse,
} from "./types";

// =============================================================================
// Router
// =============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      let response: Response;

      // Route matching
      if (path === "/api/trader/signals" && request.method === "GET") {
        response = await handleGetSignals(env);
      } else if (path === "/api/trader/signals" && request.method === "POST") {
        response = await handlePostSignal(request, env);
      } else if (path === "/api/trader/performance" && request.method === "GET") {
        response = await handleGetPerformance(env);
      } else if (path === "/api/trader/portfolio" && request.method === "GET") {
        response = await handleGetPortfolio(env);
      } else if (path === "/api/trader/trades" && request.method === "GET") {
        response = await handleGetTrades(env);
      } else if (path === "/api/trader/sources" && request.method === "GET") {
        response = await handleGetSources(env);
      } else if (path === "/api/trader/execute" && request.method === "POST") {
        response = await handleExecuteTrade(request, env);
      } else if (path === "/api/trader/health" && request.method === "GET") {
        response = await handleHealth(env);
      } else {
        response = jsonResponse({ success: false, error: "Not found" }, 404);
      }

      // Add CORS headers to response
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    } catch (error) {
      console.error("Worker error:", error);
      return jsonResponse(
        { success: false, error: "Internal server error" },
        500,
        corsHeaders
      );
    }
  },

  // Scheduled handler for periodic tasks
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    console.log("Scheduled task running:", event.cron);

    // Update performance history daily
    if (event.cron === "0 0 * * *") {
      await updatePerformanceHistory(env);
    }

    // Sync portfolio from Fidelity every 8 hours
    if (event.cron === "0 */8 * * *") {
      await syncPortfolio(env);
    }
  },
};

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(
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

function verifyApiKey(request: Request, env: Env, keyName: "SCRAPER_API_KEY" | "TRADER_API_KEY"): boolean {
  const apiKey = request.headers.get("X-API-Key") || request.headers.get("Authorization")?.replace("Bearer ", "");
  return apiKey === env[keyName];
}

function generateId(): string {
  return `sig_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// =============================================================================
// Signal Handlers
// =============================================================================

async function handleGetSignals(env: Env): Promise<Response> {
  const results = await env.DB.prepare(`
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

async function handlePostSignal(request: Request, env: Env): Promise<Response> {
  // Verify API key from scraper
  if (!verifyApiKey(request, env, "SCRAPER_API_KEY")) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  const signal: Signal = await request.json();

  // Check for duplicate
  const existing = await env.DB.prepare(
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
  const id = generateId();

  await env.DB.prepare(`
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

  // TODO: Trigger signal processing (position sizing, execution decision)

  return jsonResponse({
    success: true,
    message: "Signal received",
    id,
  });
}

// =============================================================================
// Performance Handler
// =============================================================================

async function handleGetPerformance(env: Env): Promise<Response> {
  const history = await env.DB.prepare(`
    SELECT date, signals_value, portfolio_value, sp500_value
    FROM performance_history
    ORDER BY date ASC
  `).all();

  const data = history.results as any[];

  // Calculate metrics
  const calcMetrics = (values: number[]) => {
    if (values.length < 2) {
      return { total_return_pct: 0, mtd_return_pct: 0, ytd_return_pct: 0 };
    }
    const first = values[0];
    const last = values[values.length - 1];
    const total_return_pct = ((last - first) / first) * 100;

    // MTD: from start of month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const mtdValues = data.filter((d) => new Date(d.date) >= monthStart);
    const mtd_return_pct =
      mtdValues.length > 1
        ? ((mtdValues[mtdValues.length - 1] - mtdValues[0]) / mtdValues[0]) * 100
        : 0;

    // YTD: from start of year
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const ytdValues = data.filter((d) => new Date(d.date) >= yearStart);
    const ytd_return_pct =
      ytdValues.length > 1
        ? ((ytdValues[ytdValues.length - 1] - ytdValues[0]) / ytdValues[0]) * 100
        : 0;

    return { total_return_pct, mtd_return_pct, ytd_return_pct };
  };

  const signalsHistory = data.map((d) => ({ date: d.date, value: d.signals_value }));
  const portfolioHistory = data.map((d) => ({ date: d.date, value: d.portfolio_value }));
  const sp500History = data.map((d) => ({ date: d.date, value: d.sp500_value }));

  return jsonResponse({
    signals_performance: {
      ...calcMetrics(data.map((d) => d.signals_value)),
      history: signalsHistory,
    },
    portfolio_performance: {
      ...calcMetrics(data.map((d) => d.portfolio_value)),
      history: portfolioHistory,
    },
    sp500_performance: {
      ...calcMetrics(data.map((d) => d.sp500_value)),
      history: sp500History,
    },
    last_updated: new Date().toISOString(),
  });
}

// =============================================================================
// Portfolio Handler
// =============================================================================

async function handleGetPortfolio(env: Env): Promise<Response> {
  const positions = await env.DB.prepare(`
    SELECT * FROM positions WHERE quantity > 0
  `).all();

  // Get current prices (in production, fetch from market data API)
  const positionsWithPrices = positions.results.map((p: any) => {
    const current_price = p.current_price || p.avg_cost; // Placeholder
    const market_value = p.quantity * current_price;
    const cost_basis = p.quantity * p.avg_cost;
    const unrealized_pnl = market_value - cost_basis;
    const unrealized_pnl_pct = (unrealized_pnl / cost_basis) * 100;

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

  const cash = await env.DB.prepare("SELECT value FROM config WHERE key = 'cash_balance'").first();
  const cashBalance = cash?.value ? parseFloat(cash.value as string) : 0;
  const totalValue = positionsWithPrices.reduce((sum, p) => sum + p.market_value, 0) + cashBalance;

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

async function handleGetTrades(env: Env): Promise<Response> {
  const trades = await env.DB.prepare(`
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

async function handleGetSources(env: Env): Promise<Response> {
  const stats = await env.DB.prepare(`
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

async function handleExecuteTrade(request: Request, env: Env): Promise<Response> {
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
      await env.DB.prepare(`
        INSERT INTO trades (id, ticker, action, quantity, price, total, status, executed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          `trade_${Date.now()}`,
          tradeRequest.ticker,
          tradeRequest.action,
          tradeRequest.quantity,
          result.details?.price || 0,
          (result.details?.price || 0) * tradeRequest.quantity,
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

async function handleHealth(env: Env): Promise<Response> {
  // Check DB connection
  let dbOk = false;
  try {
    await env.DB.prepare("SELECT 1").first();
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
// Scheduled Tasks
// =============================================================================

async function updatePerformanceHistory(env: Env): Promise<void> {
  // Get current portfolio value
  const portfolio = await env.DB.prepare(`
    SELECT SUM(quantity * avg_cost) as value FROM positions WHERE quantity > 0
  `).first();

  const portfolioValue = portfolio?.value || 10000;

  // Get S&P 500 value (placeholder - would fetch from market data)
  const sp500Value = 10000;

  // Get signals theoretical value (placeholder)
  const signalsValue = 10000;

  const today = new Date().toISOString().split("T")[0];

  await env.DB.prepare(`
    INSERT OR REPLACE INTO performance_history (date, signals_value, portfolio_value, sp500_value)
    VALUES (?, ?, ?, ?)
  `)
    .bind(today, signalsValue, portfolioValue, sp500Value)
    .run();
}

async function syncPortfolio(env: Env): Promise<void> {
  // Fetch portfolio from trader-worker
  try {
    const resp = await fetch(`${env.TUNNEL_URL}/accounts`, {
      headers: { "X-API-Key": env.TRADER_API_KEY },
    });

    if (!resp.ok) return;

    const data = await resp.json();

    // Update positions in DB
    for (const account of data.accounts || []) {
      for (const position of account.positions || []) {
        await env.DB.prepare(`
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
  } catch (error) {
    console.error("Portfolio sync error:", error);
  }
}
