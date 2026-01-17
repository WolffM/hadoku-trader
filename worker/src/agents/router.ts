/**
 * Signal routing to multiple agents
 * Routes incoming signals to all applicable agents and records decisions
 */

import type { TraderEnv } from "../types";
import type {
  AgentConfig,
  EnrichedSignal,
  AgentDecision,
  DecisionReason,
} from "./types";
import {
  getActiveAgents,
  getAgentBudget,
  countAgentPositions,
  countAgentTickerPositions,
} from "./loader";
import {
  shouldAgentProcessSignal,
  enrichSignal,
  generateId,
  type RawSignalRow,
} from "./filters";
import { calculateScore } from "./scoring";
import { calculatePositionSize } from "./sizing";
import { executeTrade, getPendingTradeId } from "./execution";

// =============================================================================
// Main Routing Functions
// =============================================================================

/**
 * Route a signal to all applicable agents and record decisions.
 * Returns array of decisions made by each agent.
 */
export async function routeSignalToAgents(
  env: TraderEnv,
  signalRow: RawSignalRow,
  currentPrice: number,
  executeImmediately: boolean = true
): Promise<AgentDecision[]> {
  const signal = enrichSignal(signalRow, currentPrice);
  const agents = await getActiveAgents(env);
  const decisions: AgentDecision[] = [];

  for (const agent of agents) {
    const decision = await processSignalForAgent(env, agent, signal);

    // Log the decision to database first
    const tradeId = await logAgentDecision(env, decision, signal);

    // If decision is to execute, calculate size and execute trade
    if (
      executeImmediately &&
      (decision.action === "execute" || decision.action === "execute_half")
    ) {
      const executionResult = await executeDecision(
        env,
        agent,
        signal,
        decision,
        tradeId
      );

      // Update decision with position size from execution
      decision.position_size = executionResult.positionSize;
    }

    decisions.push(decision);
  }

  return decisions;
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
  const budget = await getAgentBudget(env, agent.id);

  // Calculate position size
  const positionSize = calculatePositionSize(
    agent,
    decision.score,
    budget,
    1, // acceptedSignalsCount - for equal_split mode
    decision.action === "execute_half"
  );

  // Check if position size is valid
  if (positionSize === 0) {
    // Update trade record to reflect skip due to budget
    await env.TRADER_DB.prepare(
      `UPDATE trades SET decision = 'skip_budget', status = 'skipped' WHERE id = ?`
    )
      .bind(tradeId)
      .run();

    return { positionSize: 0, success: false };
  }

  // Execute the trade
  const result = await executeTrade(
    env,
    agent,
    signal,
    decision,
    positionSize,
    tradeId
  );

  return { positionSize, success: result.success };
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
  const filterResult = shouldAgentProcessSignal(agent, signal);

  if (!filterResult.passes) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "skip",
      decision_reason: filterResult.reason as DecisionReason,
      score: null,
      score_breakdown: null,
      position_size: null,
    };
  }

  // Step 2: Check position limits
  const positionCheck = await checkPositionLimits(env, agent, signal.ticker);
  if (!positionCheck.allowed) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "skip",
      decision_reason: "skip_budget", // Using skip_budget for limit violations
      score: null,
      score_breakdown: null,
      position_size: null,
    };
  }

  // Step 3: Scoring
  let score: number | null = null;
  let breakdown: Record<string, number> | null = null;

  if (agent.scoring) {
    const scoreResult = await calculateScore(env, agent.scoring, signal);
    score = scoreResult.score;
    breakdown = scoreResult.breakdown;
  }

  // Step 4: Decision based on threshold
  // For agents without scoring (Gemini), they automatically pass if filters pass
  if (agent.scoring === null) {
    // Gemini-style: any passing signal = execute
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "execute",
      decision_reason: "execute",
      score: null,
      score_breakdown: null,
      position_size: null, // Will be calculated during execution
    };
  }

  // For scoring agents, check threshold
  if (score !== null && score >= agent.execute_threshold) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "execute",
      decision_reason: "execute",
      score,
      score_breakdown: breakdown,
      position_size: null, // Will be calculated during execution
    };
  }

  // Check half-size threshold (REBALANCE)
  if (
    score !== null &&
    agent.half_size_threshold !== null &&
    score >= agent.half_size_threshold
  ) {
    return {
      agent_id: agent.id,
      signal_id: signal.id,
      action: "execute_half",
      decision_reason: "execute_half",
      score,
      score_breakdown: breakdown,
      position_size: null,
    };
  }

  // Score too low
  return {
    agent_id: agent.id,
    signal_id: signal.id,
    action: "skip",
    decision_reason: "skip_score",
    score,
    score_breakdown: breakdown,
    position_size: null,
  };
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
): Promise<{ allowed: boolean; reason?: string }> {
  // Check max open positions
  const totalPositions = await countAgentPositions(env, agent.id);
  if (totalPositions >= agent.sizing.max_open_positions) {
    return {
      allowed: false,
      reason: `max_positions_${agent.sizing.max_open_positions}`,
    };
  }

  // Check max per ticker
  const tickerPositions = await countAgentTickerPositions(
    env,
    agent.id,
    ticker
  );
  if (tickerPositions >= agent.sizing.max_per_ticker) {
    return {
      allowed: false,
      reason: `max_per_ticker_${agent.sizing.max_per_ticker}`,
    };
  }

  return { allowed: true };
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
  const now = new Date().toISOString();
  const tradeId = generateId("trade");

  // Determine status based on decision
  const status =
    decision.action === "skip"
      ? "skipped"
      : decision.action === "execute" || decision.action === "execute_half"
        ? "pending"
        : "skipped";

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
    .run();

  return tradeId;
}

// =============================================================================
// Signal Processing Queries
// =============================================================================

/**
 * Get signals that haven't been processed by agents yet.
 * Returns signals where processed_at is NULL.
 */
export async function getUnprocessedSignals(
  env: TraderEnv
): Promise<RawSignalRow[]> {
  const results = await env.TRADER_DB.prepare(
    `
    SELECT
      id,
      ticker,
      action,
      asset_type,
      disclosed_price,
      disclosed_date,
      filing_date,
      position_size_min,
      politician_name,
      source
    FROM signals
    WHERE processed_at IS NULL
    ORDER BY scraped_at ASC
    LIMIT 50
  `
  ).all();

  return results.results as unknown as RawSignalRow[];
}

/**
 * Mark a signal as processed.
 */
export async function markSignalProcessed(
  env: TraderEnv,
  signalId: string
): Promise<void> {
  await env.TRADER_DB.prepare(
    `
    UPDATE signals SET processed_at = ? WHERE id = ?
  `
  )
    .bind(new Date().toISOString(), signalId)
    .run();
}

/**
 * Get current price for a ticker from positions table or return null.
 */
export async function getCurrentPrice(
  env: TraderEnv,
  ticker: string
): Promise<number | null> {
  const row = await env.TRADER_DB.prepare(
    `
    SELECT current_price FROM positions WHERE ticker = ?
  `
  )
    .bind(ticker)
    .first();

  return (row?.current_price as number) ?? null;
}

/**
 * Batch process all unprocessed signals.
 * Called by scheduled job or manual trigger.
 */
export async function processAllPendingSignals(
  env: TraderEnv
): Promise<{
  processed_count: number;
  results: Array<{
    signal_id: string;
    ticker: string;
    decisions: Array<{ agent_id: string; action: string; reason: string }>;
  }>;
}> {
  const unprocessed = await getUnprocessedSignals(env);
  const results: Array<{
    signal_id: string;
    ticker: string;
    decisions: Array<{ agent_id: string; action: string; reason: string }>;
  }> = [];

  for (const signal of unprocessed) {
    // Get current price (from positions table or use disclosed price)
    const currentPrice =
      (await getCurrentPrice(env, signal.ticker)) ??
      signal.disclosed_price ??
      0;

    if (currentPrice === 0) {
      console.warn(`No price available for ${signal.ticker}, skipping signal`);
      await markSignalProcessed(env, signal.id);
      continue;
    }

    const decisions = await routeSignalToAgents(env, signal, currentPrice);
    await markSignalProcessed(env, signal.id);

    results.push({
      signal_id: signal.id,
      ticker: signal.ticker,
      decisions: decisions.map((d) => ({
        agent_id: d.agent_id,
        action: d.action,
        reason: d.decision_reason,
      })),
    });
  }

  return {
    processed_count: results.length,
    results,
  };
}
