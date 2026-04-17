/**
 * Position Monitoring Engine for Multi-Agent Trading System
 * Implements exit conditions: stop-loss, take-profit, time exit, soft stop.
 */

import type { TraderEnv } from '../types'
import type { AgentConfig, PositionRow, CloseReason, ExitDecision, MonitorResult } from './types'
import { daysBetween, getCurrentDate } from './filters'
import { getAgent } from './loader'
import { executeSellOrder } from './execution'

// =============================================================================
// Main Monitoring Function
// =============================================================================

/**
 * Monitor all open positions and execute exits as needed.
 * Called by scheduled job every 15 minutes during market hours.
 */
export async function monitorPositions(env: TraderEnv): Promise<MonitorResult> {
  const result: MonitorResult = {
    positions_checked: 0,
    exits_triggered: 0,
    exits: [],
    highest_price_updates: 0,
    errors: []
  }

  try {
    // Get all open positions
    const positions = await getAllOpenPositions(env)
    result.positions_checked = positions.length

    for (const position of positions) {
      try {
        // Get current price for the ticker
        const currentPrice = await getCurrentPriceForTicker(env, position.ticker)
        if (currentPrice === null) {
          result.errors.push(`No price available for ${position.ticker} (position ${position.id})`)
          continue
        }

        // Mark-to-market: always persist the latest price on the position
        // row so /agents total_return_pct and any downstream consumer see
        // a non-null current_price.
        await updatePositionCurrentPrice(env, position.id, currentPrice)
        position.current_price = currentPrice

        // Update highest price if new high
        if (currentPrice > position.highest_price) {
          await updateHighestPrice(env, position.id, currentPrice)
          result.highest_price_updates++
          position.highest_price = currentPrice // Update local copy for exit check
        }

        // Get agent config for exit rules
        const agent = await getAgent(env, position.agent_id)
        if (!agent) {
          result.errors.push(`Agent not found: ${position.agent_id} (position ${position.id})`)
          continue
        }

        // Check exit conditions
        const exitDecision = checkExitConditions(position, agent, currentPrice)
        if (exitDecision) {
          // Execute the exit
          const closeResult = await executeExit(env, position, agent, exitDecision, currentPrice)

          if (closeResult.success) {
            result.exits_triggered++
            result.exits.push({
              position_id: position.id,
              ticker: position.ticker,
              agent_id: position.agent_id,
              reason: exitDecision.reason,
              sell_pct: exitDecision.sell_pct
            })
          } else {
            result.errors.push(`Exit failed for ${position.ticker}: ${closeResult.error}`)
          }
        }
      } catch (posError) {
        result.errors.push(
          `Error processing position ${position.id}: ${posError instanceof Error ? posError.message : 'Unknown error'}`
        )
      }
    }
  } catch (error) {
    result.errors.push(
      `Monitoring error: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }

  return result
}

// =============================================================================
// Exit Condition Checking
// =============================================================================

/**
 * Check all exit conditions for a position.
 * Returns ExitDecision if an exit should be triggered, null otherwise.
 */
export function checkExitConditions(
  position: PositionRow,
  agent: AgentConfig,
  currentPrice: number
): ExitDecision | null {
  const returnPct = ((currentPrice - position.entry_price) / position.entry_price) * 100
  const dropFromHigh = ((position.highest_price - currentPrice) / position.highest_price) * 100
  const daysHeld = daysBetween(position.entry_date, getCurrentDate())

  // 1. Check stop-loss (highest priority)
  const stopLossResult = checkStopLoss(agent, returnPct, dropFromHigh)
  if (stopLossResult) {
    return stopLossResult
  }

  // 2. Check take-profit (Claude only)
  const takeProfitResult = checkTakeProfit(agent, returnPct, position.partial_sold === 1)
  if (takeProfitResult) {
    return takeProfitResult
  }

  // 3. Check time exit
  const timeExitResult = checkTimeExit(agent, daysHeld)
  if (timeExitResult) {
    return timeExitResult
  }

  // 4. Check soft stop (ChatGPT only)
  const softStopResult = checkSoftStop(agent, position.asset_type, daysHeld, returnPct)
  if (softStopResult) {
    return softStopResult
  }

  return null
}

/**
 * Check stop-loss condition (fixed or trailing).
 */
function checkStopLoss(
  agent: AgentConfig,
  returnPct: number,
  dropFromHigh: number
): ExitDecision | null {
  const { stop_loss } = agent.exit

  if (stop_loss.mode === 'fixed') {
    // Fixed stop-loss: exit if return drops below -threshold
    if (returnPct <= -stop_loss.threshold_pct) {
      return { action: 'close', reason: 'stop_loss', sell_pct: 100 }
    }
  } else if (stop_loss.mode === 'trailing') {
    // Trailing stop-loss: exit if price drops threshold% from highest
    if (dropFromHigh >= stop_loss.threshold_pct) {
      return { action: 'close', reason: 'stop_loss', sell_pct: 100 }
    }
  }

  return null
}

/**
 * Check take-profit condition (tiered, Claude only).
 */
function checkTakeProfit(
  agent: AgentConfig,
  returnPct: number,
  alreadyPartialSold: boolean
): ExitDecision | null {
  const { take_profit } = agent.exit
  if (!take_profit) {
    return null
  }

  // Check second tier (full exit at 40%+)
  if (returnPct >= take_profit.second_threshold_pct) {
    return { action: 'close', reason: 'take_profit', sell_pct: 100 }
  }

  // Check first tier (partial sell at 25%+) - only if not already done
  if (returnPct >= take_profit.first_threshold_pct && !alreadyPartialSold) {
    return {
      action: 'partial',
      reason: 'take_profit',
      sell_pct: take_profit.first_sell_pct
    }
  }

  return null
}

/**
 * Check time-based exit condition.
 */
function checkTimeExit(agent: AgentConfig, daysHeld: number): ExitDecision | null {
  const { max_hold_days } = agent.exit

  if (max_hold_days !== null && daysHeld >= max_hold_days) {
    return { action: 'close', reason: 'time_exit', sell_pct: 100 }
  }

  return null
}

/**
 * Check soft stop condition (ChatGPT only).
 * Exits if position shows no progress after specified days.
 */
function checkSoftStop(
  agent: AgentConfig,
  assetType: string,
  daysHeld: number,
  returnPct: number
): ExitDecision | null {
  const { soft_stop } = agent.exit
  if (!soft_stop) {
    return null
  }

  const noProgressDays =
    assetType === 'option' ? soft_stop.no_progress_days_option : soft_stop.no_progress_days_stock

  // Exit if held for noProgressDays and return is still <= 0
  if (daysHeld >= noProgressDays && returnPct <= 0) {
    return { action: 'close', reason: 'soft_stop', sell_pct: 100 }
  }

  return null
}

// =============================================================================
// Exit Execution
// =============================================================================

/**
 * Execute an exit (full close or partial sell).
 */
async function executeExit(
  env: TraderEnv,
  position: PositionRow,
  agent: AgentConfig,
  decision: ExitDecision,
  currentPrice: number
): Promise<{ success: boolean; error?: string }> {
  const sharesToSell = Math.floor((position.shares * decision.sell_pct) / 100)

  if (sharesToSell === 0) {
    return { success: false, error: 'No shares to sell' }
  }

  // Execute sell order via Fidelity API
  const sellResult = await executeSellOrder(
    env,
    position.agent_id,
    position.ticker,
    sharesToSell,
    currentPrice,
    decision.reason
  )

  if (!sellResult.success) {
    return { success: false, error: sellResult.error }
  }

  // Update position in database
  if (decision.action === 'close' || sharesToSell >= position.shares) {
    // Full close
    await closePosition(env, position.id, decision.reason, currentPrice)
  } else {
    // Partial sell - update shares and mark as partial sold
    await partialClosePosition(env, position.id, sharesToSell, currentPrice)
  }

  return { success: true }
}

// =============================================================================
// Database Operations
// =============================================================================

/**
 * Get all open positions from database.
 */
export async function getAllOpenPositions(env: TraderEnv): Promise<PositionRow[]> {
  const results = await env.TRADER_DB.prepare(
    `
    SELECT * FROM positions WHERE status = 'open'
  `
  ).all()

  return results.results as unknown as PositionRow[]
}

/**
 * Get current price for a ticker from the latest market_prices row.
 *
 * Previously read positions.current_price, but nothing in the codebase
 * ever writes to that column — it starts NULL on insert and stays NULL
 * forever. The effect was that monitor-positions always reported "No
 * price available" and stop-loss / take-profit could never fire.
 * market_prices is populated daily by syncMarketPrices (scheduled.ts)
 * for every open position's ticker, so it's the authoritative source.
 */
async function getCurrentPriceForTicker(env: TraderEnv, ticker: string): Promise<number | null> {
  const row = await env.TRADER_DB.prepare(
    `SELECT close FROM market_prices WHERE ticker = ? ORDER BY date DESC LIMIT 1`
  )
    .bind(ticker)
    .first()

  return (row?.close as number) ?? null
}

/**
 * Mark-to-market: write the latest price onto an open position so
 * /agents total_return_pct and similar reads don't see NULL.
 */
export async function updatePositionCurrentPrice(
  env: TraderEnv,
  positionId: string,
  currentPrice: number
): Promise<void> {
  await env.TRADER_DB.prepare(`UPDATE positions SET current_price = ? WHERE id = ?`)
    .bind(currentPrice, positionId)
    .run()
}

/**
 * Update highest price for a position (for trailing stops).
 */
export async function updateHighestPrice(
  env: TraderEnv,
  positionId: string,
  newHighestPrice: number
): Promise<void> {
  await env.TRADER_DB.prepare(
    `
    UPDATE positions SET highest_price = ? WHERE id = ?
  `
  )
    .bind(newHighestPrice, positionId)
    .run()
}

/**
 * Close a position completely.
 */
export async function closePosition(
  env: TraderEnv,
  positionId: string,
  reason: CloseReason,
  closePrice: number
): Promise<void> {
  const now = new Date().toISOString()

  await env.TRADER_DB.prepare(
    `
    UPDATE positions
    SET status = 'closed', closed_at = ?, close_price = ?, close_reason = ?
    WHERE id = ?
  `
  )
    .bind(now, closePrice, reason, positionId)
    .run()
}

/**
 * Partially close a position (reduce shares, mark partial_sold).
 */
export async function partialClosePosition(
  env: TraderEnv,
  positionId: string,
  sharesSold: number,
  _salePrice: number
): Promise<void> {
  await env.TRADER_DB.prepare(
    `
    UPDATE positions
    SET shares = shares - ?, partial_sold = 1
    WHERE id = ?
  `
  )
    .bind(sharesSold, positionId)
    .run()
}

/**
 * Get positions for a specific agent.
 */
export async function getAgentOpenPositions(
  env: TraderEnv,
  agentId: string
): Promise<PositionRow[]> {
  const results = await env.TRADER_DB.prepare(
    `
    SELECT * FROM positions WHERE agent_id = ? AND status = 'open'
  `
  )
    .bind(agentId)
    .all()

  return results.results as unknown as PositionRow[]
}
