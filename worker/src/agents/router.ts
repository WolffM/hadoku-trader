/**
 * Signal routing to multiple agents
 * Routes incoming signals to all applicable agents and records decisions
 */

import type { TraderEnv } from '../types'
import type {
  AgentConfig,
  EnrichedSignal,
  AgentDecision,
  DecisionReason,
  TradeAction
} from './types'
import {
  getActiveAgents,
  getActiveAgentsWithTopPoliticians,
  getAgentBudget,
  countAgentPositions,
  countAgentTickerPositions,
  getAgentTickerPosition
} from './loader'
import { closePosition } from './monitor'
import { shouldAgentProcessSignal, enrichSignal, generateId, type RawSignalRow } from './filters'
import { calculateScore } from './scoring'
import { calculatePositionSize, calculateShares } from './sizing'
import { executeTrade } from './execution'
import { MIN_POSITION_AGE_DAYS } from './tradingConfig'

// =============================================================================
// Main Routing Functions
// =============================================================================

/**
 * Route a signal to all applicable agents and record decisions.
 * Returns array of decisions made by each agent.
 *
 * For SELL signals: checks if agent has an open position and closes it.
 * For BUY signals: applies filters, scoring, and executes if threshold met.
 *
 * @param evaluationDate - Optional date to evaluate signal from. Use disclosure_date for replay/simulation,
 *                         or omit for live processing (defaults to today).
 */
export async function routeSignalToAgents(
  env: TraderEnv,
  signalRow: RawSignalRow,
  currentPrice: number,
  executeImmediately = true,
  evaluationDate?: string
): Promise<AgentDecision[]> {
  // For replay scenarios, use disclosure_date; for live processing, use today
  const evalDate = evaluationDate ?? signalRow.disclosure_date

  console.log(`\n${'='.repeat(80)}`)
  console.log(`[ROUTER] Processing signal: ${signalRow.id}`)
  console.log(`[ROUTER]   Ticker: ${signalRow.ticker}, Action: ${signalRow.action}`)
  console.log(`[ROUTER]   Politician: ${signalRow.politician_name}`)
  console.log(
    `[ROUTER]   Trade Date: ${signalRow.trade_date}, Trade Price: $${signalRow.trade_price}`
  )
  console.log(`[ROUTER]   Disclosure Date: ${signalRow.disclosure_date}`)
  console.log(`[ROUTER]   Evaluation Date: ${evalDate}`)
  console.log(`[ROUTER]   Position Size: $${signalRow.position_size_min?.toLocaleString()}`)
  console.log(`[ROUTER]   Current Price: $${currentPrice}`)
  console.log(`[ROUTER]   Execute Immediately: ${executeImmediately}`)
  console.log(`${'='.repeat(80)}`)

  const signal = enrichSignal(signalRow, currentPrice, evalDate)

  // Use dynamic Top 10 filter for production (applies rankings to agents with null whitelist)
  const agents = await getActiveAgentsWithTopPoliticians(env, 10)
  const decisions: AgentDecision[] = []

  console.log(
    `[ROUTER] Routing to ${agents.length} active agents: ${agents.map(a => a.id).join(', ')}`
  )

  for (const agent of agents) {
    console.log(`\n[ROUTER] --- Agent: ${agent.id} (${agent.name}) ---`)

    // Handle SELL signals: close existing positions
    if (signal.action === 'sell') {
      console.log(`[ROUTER]   Processing SELL signal for ${agent.id}`)
      const sellDecision = await processSellSignalForAgent(
        env,
        agent,
        signal,
        currentPrice,
        executeImmediately
      )
      console.log(
        `[ROUTER]   SELL Decision: ${sellDecision.action} (${sellDecision.decision_reason})`
      )
      decisions.push(sellDecision)
      continue
    }

    // Handle BUY signals: normal processing
    console.log(`[ROUTER]   Processing BUY signal for ${agent.id}`)
    const decision = await processSignalForAgent(env, agent, signal)

    console.log(`[ROUTER]   Decision: ${decision.action}`)
    console.log(`[ROUTER]   Reason: ${decision.decision_reason}`)
    if (decision.score !== null) {
      console.log(`[ROUTER]   Score: ${decision.score.toFixed(3)}`)
      if (decision.score_breakdown) {
        console.log(`[ROUTER]   Score Breakdown: ${JSON.stringify(decision.score_breakdown)}`)
      }
    }

    // Log the decision to database first
    const tradeId = await logAgentDecision(env, decision, signal)
    console.log(`[ROUTER]   Trade ID: ${tradeId}`)

    // If decision is to execute, calculate size and execute trade
    if (
      executeImmediately &&
      (decision.action === 'execute' || decision.action === 'execute_half')
    ) {
      console.log(`[ROUTER]   Executing trade...`)
      const executionResult = await executeDecision(env, agent, signal, decision, tradeId)

      console.log(`[ROUTER]   Execution Result: ${executionResult.success ? 'SUCCESS' : 'FAILED'}`)
      console.log(`[ROUTER]   Position Size: $${executionResult.positionSize.toFixed(2)}`)

      // Update decision with position size from execution
      decision.position_size = executionResult.positionSize
    }

    decisions.push(decision)
  }

  console.log(
    `\n[ROUTER] Routing complete. Decisions: ${decisions.map(d => `${d.agent_id}:${d.action}`).join(', ')}`
  )
  console.log(`${'='.repeat(80)}\n`)

  return decisions
}

/**
 * Process a SELL signal for a single agent.
 * If agent has an open position for this ticker, close it.
 * Otherwise skip (no short selling).
 */
async function processSellSignalForAgent(
  env: TraderEnv,
  agent: AgentConfig,
  signal: EnrichedSignal,
  currentPrice: number,
  executeImmediately: boolean
): Promise<AgentDecision> {
  // Check if agent has an open position for this ticker
  const position = await getAgentTickerPosition(env, agent.id, signal.ticker)

  if (!position) {
    // No position to sell - skip (no shorting allowed)
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: 'skip',
      decision_reason: 'skip_no_position',
      score: null,
      score_breakdown: null,
      position_size: null
    }
  }

  // Check if position is old enough to sell (>= 1 year for long-term capital gains)
  const entryDate = new Date(position.entry_date)
  const sellDate = new Date(signal.disclosure_date)
  const ageMs = sellDate.getTime() - entryDate.getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)

  if (ageDays < MIN_POSITION_AGE_DAYS) {
    // Position is too young - don't sell yet
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: 'skip',
      decision_reason: 'skip_position_young',
      score: null,
      score_breakdown: null,
      position_size: null
    }
  }

  // We have a position that's old enough - close it based on congress sell signal
  if (executeImmediately) {
    await closePosition(env, position.id, 'sell_signal', currentPrice)
  }

  // Log the sell decision
  const tradeId = generateId('trade')
  const now = new Date().toISOString()

  await env.TRADER_DB.prepare(
    `
    INSERT INTO trades (
      id, agent_id, signal_id, ticker, action, decision,
      score, score_breakdown_json, quantity, price, total,
      status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )
    .bind(
      tradeId,
      agent.id,
      signal.id,
      signal.ticker,
      'sell',
      'execute_sell',
      null,
      null,
      position.shares,
      currentPrice,
      position.shares * currentPrice,
      executeImmediately ? 'executed' : 'pending',
      now
    )
    .run()

  return {
    agent_id: agent.id,
    signal_id: signal.id,
    action: 'execute',
    decision_reason: 'execute_sell',
    score: null,
    score_breakdown: null,
    position_size: position.shares * currentPrice
  }
}

/**
 * Execute a decision by calculating position size and calling trade execution.
 */
async function executeDecision(
  env: TraderEnv,
  agent: AgentConfig,
  signal: EnrichedSignal,
  decision: AgentDecision,
  tradeId: string
): Promise<{ positionSize: number; success: boolean }> {
  // Get current budget
  const budget = await getAgentBudget(env, agent.id)

  // Calculate position size
  const positionSize = calculatePositionSize(
    agent,
    decision.score,
    budget,
    1, // acceptedSignalsCount - for equal_split mode
    decision.action === 'execute_half',
    signal.position_size_min // Congressional position size for smart_budget mode
  )

  // Check if position size is valid
  if (positionSize === 0) {
    // Update trade record to reflect skip due to size being zero
    await env.TRADER_DB.prepare(
      `UPDATE trades SET decision = 'skip_size_zero', status = 'skipped' WHERE id = ?`
    )
      .bind(tradeId)
      .run()

    return { positionSize: 0, success: false }
  }

  // Execute the trade
  const result = await executeTrade(env, agent, signal, decision, positionSize, tradeId)

  return { positionSize, success: result.success }
}

/**
 * Process a signal for a single agent.
 * Applies filters, scoring, and threshold checks.
 */
async function processSignalForAgent(
  env: TraderEnv,
  agent: AgentConfig,
  signal: EnrichedSignal
): Promise<AgentDecision> {
  // Step 1: Check hard filters
  const filterResult = shouldAgentProcessSignal(agent, signal)

  if (!filterResult.passes) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: 'skip',
      decision_reason: filterResult.reason as DecisionReason,
      score: null,
      score_breakdown: null,
      position_size: null
    }
  }

  // Step 2: Check position limits
  const positionCheck = await checkPositionLimits(env, agent, signal.ticker)
  if (!positionCheck.allowed) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: 'skip',
      decision_reason: positionCheck.reason!,
      score: null,
      score_breakdown: null,
      position_size: null
    }
  }

  // Step 3: Scoring
  let score: number | null = null
  let breakdown: Record<string, number> | null = null

  if (agent.scoring) {
    const scoreResult = await calculateScore(env, agent.scoring, signal)
    score = scoreResult.score
    breakdown = scoreResult.breakdown
  }

  // Step 4: Decision based on threshold
  // For agents without scoring (Gemini), they automatically pass if filters pass
  if (agent.scoring === null) {
    // Gemini-style: any passing signal = execute
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: 'execute',
      decision_reason: 'execute',
      score: null,
      score_breakdown: null,
      position_size: null // Will be calculated during execution
    }
  }

  // For scoring agents, check threshold
  if (score !== null && score >= agent.execute_threshold) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: 'execute',
      decision_reason: 'execute',
      score,
      score_breakdown: breakdown,
      position_size: null // Will be calculated during execution
    }
  }

  // Check half-size threshold (REBALANCE)
  if (score !== null && agent.half_size_threshold !== null && score >= agent.half_size_threshold) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: 'execute_half',
      decision_reason: 'execute_half',
      score,
      score_breakdown: breakdown,
      position_size: null
    }
  }

  // Score too low
  return {
    agent_id: agent.id,
    signal_id: signal.id,
    action: 'skip',
    decision_reason: 'skip_score',
    score,
    score_breakdown: breakdown,
    position_size: null
  }
}

// =============================================================================
// Position Limit Checks
// =============================================================================

/**
 * Check if agent can open a new position based on limits.
 */
async function checkPositionLimits(
  env: TraderEnv,
  agent: AgentConfig,
  ticker: string
): Promise<{ allowed: boolean; reason?: DecisionReason }> {
  // Check max open positions
  const totalPositions = await countAgentPositions(env, agent.id)
  if (totalPositions >= agent.sizing.max_open_positions) {
    return {
      allowed: false,
      reason: 'skip_max_positions'
    }
  }

  // Check max per ticker
  const tickerPositions = await countAgentTickerPositions(env, agent.id, ticker)
  if (tickerPositions >= agent.sizing.max_per_ticker) {
    return {
      allowed: false,
      reason: 'skip_max_ticker'
    }
  }

  return { allowed: true }
}

// =============================================================================
// Decision Logging
// =============================================================================

/**
 * Log an agent decision to the trades table.
 * Returns the generated trade ID for use in execution.
 */
async function logAgentDecision(
  env: TraderEnv,
  decision: AgentDecision,
  signal: EnrichedSignal
): Promise<string> {
  const now = new Date().toISOString()
  const tradeId = generateId('trade')

  // Determine status based on decision
  const status =
    decision.action === 'skip'
      ? 'skipped'
      : decision.action === 'execute' || decision.action === 'execute_half'
        ? 'pending'
        : 'skipped'

  await env.TRADER_DB.prepare(
    `
    INSERT INTO trades (
      id, agent_id, signal_id, ticker, action, decision,
      score, score_breakdown_json, quantity, price, total,
      status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
  `
  )
    .bind(
      tradeId,
      decision.agent_id,
      decision.signal_id,
      signal.ticker,
      signal.action,
      decision.decision_reason,
      decision.score,
      decision.score_breakdown ? JSON.stringify(decision.score_breakdown) : null,
      status,
      now
    )
    .run()

  return tradeId
}

// =============================================================================
// Signal Processing Queries
// =============================================================================

/**
 * Get signals that haven't been processed by agents yet.
 * Returns signals where processed_at is NULL.
 */
export async function getUnprocessedSignals(env: TraderEnv): Promise<RawSignalRow[]> {
  const results = await env.TRADER_DB.prepare(
    `
    SELECT
      id,
      ticker,
      action,
      asset_type,
      trade_price,
      disclosure_price,
      trade_date,
      disclosure_date,
      position_size_min,
      politician_name,
      source,
      current_price
    FROM signals
    WHERE processed_at IS NULL
    ORDER BY scraped_at ASC
    LIMIT 50
  `
  ).all()

  return results.results as unknown as RawSignalRow[]
}

/**
 * Mark a signal as processed.
 */
export async function markSignalProcessed(env: TraderEnv, signalId: string): Promise<void> {
  await env.TRADER_DB.prepare(
    `
    UPDATE signals SET processed_at = ? WHERE id = ?
  `
  )
    .bind(new Date().toISOString(), signalId)
    .run()
}

/**
 * Get current price for a ticker from positions table or return null.
 */
export async function getCurrentPrice(env: TraderEnv, ticker: string): Promise<number | null> {
  const row = await env.TRADER_DB.prepare(
    `
    SELECT current_price FROM positions WHERE ticker = ?
  `
  )
    .bind(ticker)
    .first()

  return (row?.current_price as number) ?? null
}

/**
 * Batch process all unprocessed signals.
 * Called by scheduled job or manual trigger.
 */
export async function processAllPendingSignals(env: TraderEnv): Promise<{
  processed_count: number
  results: {
    signal_id: string
    ticker: string
    decisions: { agent_id: string; action: string; reason: string }[]
  }[]
}> {
  const unprocessed = await getUnprocessedSignals(env)
  const results: {
    signal_id: string
    ticker: string
    decisions: { agent_id: string; action: string; reason: string }[]
  }[] = []

  for (const signal of unprocessed) {
    // Get current price: prefer signal's stored current_price, then positions table, then trade_price
    const currentPrice =
      signal.current_price ?? (await getCurrentPrice(env, signal.ticker)) ?? signal.trade_price ?? 0

    console.log(`[PROCESS] Signal ${signal.id} (${signal.ticker}):`)
    console.log(`[PROCESS]   signal.current_price: ${signal.current_price}`)
    console.log(`[PROCESS]   signal.trade_price: ${signal.trade_price}`)
    console.log(`[PROCESS]   Using currentPrice: $${currentPrice}`)

    if (currentPrice === 0) {
      console.warn(`[PROCESS] No price available for ${signal.ticker}, skipping signal`)
      await markSignalProcessed(env, signal.id)
      continue
    }

    const decisions = await routeSignalToAgents(env, signal, currentPrice)
    await markSignalProcessed(env, signal.id)

    results.push({
      signal_id: signal.id,
      ticker: signal.ticker,
      decisions: decisions.map(d => ({
        agent_id: d.agent_id,
        action: d.action,
        reason: d.decision_reason
      }))
    })
  }

  return {
    processed_count: results.length,
    results
  }
}

// =============================================================================
// Pure Analysis Function (Phase 5 - for hadoku-site integration)
// =============================================================================

/**
 * Analyze signals and return trade actions without executing them.
 * This is a pure decision engine - hadoku-site handles actual execution.
 *
 * @param env - Environment with DB access
 * @param signals - Enriched signals to analyze
 * @returns Array of TradeAction with all decision data for each agent
 */
export async function analyzeSignals(
  env: TraderEnv,
  signals: EnrichedSignal[]
): Promise<TradeAction[]> {
  const actions: TradeAction[] = []
  const agents = await getActiveAgents(env)

  for (const signal of signals) {
    for (const agent of agents) {
      // Get decision from existing logic
      const decision = await processSignalForAgent(env, agent, signal)

      // Calculate position size if executing
      let quantity = 0
      let positionSize = 0

      if (decision.action === 'execute' || decision.action === 'execute_half') {
        const budget = await getAgentBudget(env, agent.id)
        positionSize = calculatePositionSize(
          agent,
          decision.score ?? 0,
          budget,
          1, // signalCount for equal_split mode
          decision.action === 'execute_half',
          signal.position_size_min // Congressional position size for smart_budget mode
        )
        quantity = calculateShares(positionSize, signal.current_price, true) // Fractional shares
      }

      actions.push({
        agent_id: agent.id,
        agent_name: agent.name,
        signal_id: signal.id,
        ticker: signal.ticker,
        action: signal.action,
        decision: decision.action,
        quantity,
        position_size: positionSize,
        current_price: signal.current_price,
        score: decision.score,
        score_breakdown: decision.score_breakdown,
        reasoning: decision.decision_reason
      })
    }
  }

  return actions
}
