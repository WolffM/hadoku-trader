/**
 * Trade Execution Engine for Multi-Agent Trading System
 * Handles trade execution via Fidelity API and position management.
 */

import type { TraderEnv } from "../types";
import type {
  AgentConfig,
  EnrichedSignal,
  AgentDecision,
  AssetType,
  ExecutionResult,
  ExecutionDetails,
  FidelityTradeRequest,
  FidelityTradeResponse,
} from "./types";
import { generateId, getCurrentDate } from "./filters";
import { updateAgentBudget } from "./loader";
import { calculateShares } from "./sizing";
import { isDryRun, ENABLE_FRACTIONAL_SHARES } from "./tradingConfig";

// =============================================================================
// Trade Execution
// =============================================================================

/**
 * Execute a trade for an agent based on their decision.
 *
 * @param env - Environment with DB and API access
 * @param agent - Agent configuration
 * @param signal - The enriched signal that triggered the trade
 * @param decision - The agent's decision (must be execute or execute_half)
 * @param positionSize - Dollar amount to invest
 * @param tradeId - ID of the existing trade record to update
 * @returns Execution result with success status and details
 */
export async function executeTrade(
  env: TraderEnv,
  agent: AgentConfig,
  signal: EnrichedSignal,
  decision: AgentDecision,
  positionSize: number,
  tradeId: string
): Promise<ExecutionResult> {
  const now = new Date().toISOString();

  // Calculate shares from position size and current price (fractional shares enabled)
  const shares = calculateShares(positionSize, signal.current_price, ENABLE_FRACTIONAL_SHARES);

  if (shares === 0) {
    // Position too small - mark trade as failed
    await updateTradeExecution(env, tradeId, {
      quantity: 0,
      price: signal.current_price,
      total: 0,
      status: "failed",
      executed_at: now,
      error_message: "Insufficient funds for 1 share",
    });

    return {
      success: false,
      trade_id: tradeId,
      position_id: null,
      shares: 0,
      executed_price: signal.current_price,
      total: 0,
      order_id: null,
      error: "Insufficient funds for 1 share",
    };
  }

  // Calculate actual total (may differ from positionSize due to rounding)
  const actualTotal = shares * signal.current_price;

  try {
    // Call Fidelity API
    const apiResponse = await callFidelityApi(env, {
      ticker: signal.ticker,
      quantity: shares,
      action: signal.action,
      account: undefined, // Use default account
      dry_run: isDryRun(),
    });

    if (!apiResponse.success) {
      // API call failed
      await updateTradeExecution(env, tradeId, {
        quantity: shares,
        price: signal.current_price,
        total: actualTotal,
        status: "failed",
        executed_at: now,
        error_message: apiResponse.error ?? "Unknown API error",
      });

      return {
        success: false,
        trade_id: tradeId,
        position_id: null,
        shares,
        executed_price: signal.current_price,
        total: actualTotal,
        order_id: null,
        error: apiResponse.error ?? "Unknown API error",
      };
    }

    // API call succeeded - create position and update trade
    const positionId = await createPosition(
      env,
      agent.id,
      signal.ticker,
      shares,
      signal.current_price,
      signal.id,
      signal.asset_type
    );

    await updateTradeExecution(env, tradeId, {
      quantity: shares,
      price: signal.current_price,
      total: actualTotal,
      status: "executed",
      executed_at: now,
    });

    // Update agent budget
    await updateAgentBudget(env, agent.id, actualTotal);

    return {
      success: true,
      trade_id: tradeId,
      position_id: positionId,
      shares,
      executed_price: signal.current_price,
      total: actualTotal,
      order_id: apiResponse.order_id ?? null,
      error: null,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    await updateTradeExecution(env, tradeId, {
      quantity: shares,
      price: signal.current_price,
      total: actualTotal,
      status: "failed",
      executed_at: now,
      error_message: errorMessage,
    });

    return {
      success: false,
      trade_id: tradeId,
      position_id: null,
      shares,
      executed_price: signal.current_price,
      total: actualTotal,
      order_id: null,
      error: errorMessage,
    };
  }
}

// =============================================================================
// Position Management
// =============================================================================

/**
 * Create a new position in the database.
 */
export async function createPosition(
  env: TraderEnv,
  agentId: string,
  ticker: string,
  shares: number,
  entryPrice: number,
  signalId: string,
  assetType: AssetType
): Promise<string> {
  const id = generateId("pos");
  const now = getCurrentDate();
  const costBasis = shares * entryPrice;

  await env.TRADER_DB.prepare(
    `
    INSERT INTO positions (
      id, agent_id, ticker, shares, entry_price, entry_date,
      cost_basis, highest_price, asset_type, status, signal_id, partial_sold
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 0)
  `
  )
    .bind(
      id,
      agentId,
      ticker,
      shares,
      entryPrice,
      now,
      costBasis,
      entryPrice, // highest_price starts at entry
      assetType,
      signalId
    )
    .run();

  return id;
}

/**
 * Update trade record with execution details.
 */
export async function updateTradeExecution(
  env: TraderEnv,
  tradeId: string,
  details: ExecutionDetails
): Promise<void> {
  if (details.error_message) {
    await env.TRADER_DB.prepare(
      `
      UPDATE trades
      SET quantity = ?, price = ?, total = ?, status = ?, executed_at = ?, error_message = ?
      WHERE id = ?
    `
    )
      .bind(
        details.quantity,
        details.price,
        details.total,
        details.status,
        details.executed_at,
        details.error_message,
        tradeId
      )
      .run();
  } else {
    await env.TRADER_DB.prepare(
      `
      UPDATE trades
      SET quantity = ?, price = ?, total = ?, status = ?, executed_at = ?
      WHERE id = ?
    `
    )
      .bind(
        details.quantity,
        details.price,
        details.total,
        details.status,
        details.executed_at,
        tradeId
      )
      .run();
  }
}

/**
 * Get trade ID for a pending decision (to update after execution).
 */
export async function getPendingTradeId(
  env: TraderEnv,
  agentId: string,
  signalId: string
): Promise<string | null> {
  const row = await env.TRADER_DB.prepare(
    `
    SELECT id FROM trades
    WHERE agent_id = ? AND signal_id = ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `
  )
    .bind(agentId, signalId)
    .first();

  return (row?.id as string) ?? null;
}

// =============================================================================
// Fidelity API Integration
// =============================================================================

/**
 * Call the Fidelity API via cloudflared tunnel.
 * The tunnel connects to a local PM2 process running fidelity-api.
 */
export async function callFidelityApi(
  env: TraderEnv,
  request: FidelityTradeRequest
): Promise<FidelityTradeResponse> {
  try {
    const response = await fetch(`${env.TUNNEL_URL}/execute-trade`, {
      method: "POST",
      headers: {
        "X-API-Key": env.TRADER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `API returned ${response.status}: ${text}`,
      };
    }

    const data: FidelityTradeResponse = await response.json();
    return data;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Execute a sell order for closing or partially closing a position.
 */
export async function executeSellOrder(
  env: TraderEnv,
  agentId: string,
  ticker: string,
  shares: number,
  currentPrice: number,
  reason: string
): Promise<{
  success: boolean;
  order_id?: string;
  total: number;
  error?: string;
}> {
  const total = shares * currentPrice;

  try {
    const response = await callFidelityApi(env, {
      ticker,
      quantity: shares,
      action: "sell",
      dry_run: isDryRun(),
    });

    if (!response.success) {
      return {
        success: false,
        total,
        error: response.error ?? "Unknown API error",
      };
    }

    // Credit budget back (negative spend)
    await updateAgentBudget(env, agentId, -total);

    return {
      success: true,
      order_id: response.order_id,
      total,
    };
  } catch (error) {
    return {
      success: false,
      total,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
