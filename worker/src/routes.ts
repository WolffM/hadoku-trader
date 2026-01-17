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
