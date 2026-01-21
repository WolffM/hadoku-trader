/**
 * Agent configuration loader
 * Loads agent configs from database with fallback to code constants
 */

import type { TraderEnv } from "../types";
import type { AgentConfig, AgentRow, AgentBudgetRow } from "./types";
import { AGENT_CONFIGS } from "./configs";
import { generateId, getCurrentMonth } from "./filters";

// =============================================================================
// Agent Loading
// =============================================================================

/**
 * Get all active agents with their configurations.
 * Seeds from code constants if DB is empty.
 */
export async function getActiveAgents(env: TraderEnv): Promise<AgentConfig[]> {
  const results = await env.TRADER_DB.prepare(`
    SELECT * FROM agents WHERE is_active = 1
  `).all();

  const agents: AgentConfig[] = [];

  for (const row of results.results as unknown as AgentRow[]) {
    try {
      const config = JSON.parse(row.config_json) as AgentConfig;
      agents.push(config);
    } catch (e) {
      console.error(`Failed to parse config for agent ${row.id}:`, e);
    }
  }

  // If no agents in DB, seed from code constants
  if (agents.length === 0) {
    console.log("No agents in DB, seeding from code constants...");
    await seedAgentsFromCode(env);
    return Object.values(AGENT_CONFIGS);
  }

  return agents;
}

/**
 * Get a single agent by ID.
 */
export async function getAgent(
  env: TraderEnv,
  agentId: string
): Promise<AgentConfig | null> {
  const row = (await env.TRADER_DB.prepare(`
    SELECT * FROM agents WHERE id = ?
  `)
    .bind(agentId)
    .first()) as AgentRow | null;

  if (!row) return null;

  try {
    return JSON.parse(row.config_json) as AgentConfig;
  } catch (e) {
    console.error(`Failed to parse config for agent ${agentId}:`, e);
    return null;
  }
}

/**
 * Check if an agent exists by ID.
 */
export async function agentExists(
  env: TraderEnv,
  agentId: string
): Promise<boolean> {
  const row = await env.TRADER_DB.prepare(`
    SELECT id FROM agents WHERE id = ?
  `)
    .bind(agentId)
    .first();
  return row !== null;
}

// =============================================================================
// Budget Management
// =============================================================================

/**
 * Get agent budget for current month.
 * Creates budget record if it doesn't exist.
 */
export async function getAgentBudget(
  env: TraderEnv,
  agentId: string
): Promise<{ total: number; spent: number; remaining: number }> {
  const month = getCurrentMonth();

  let budget = (await env.TRADER_DB.prepare(`
    SELECT * FROM agent_budgets WHERE agent_id = ? AND month = ?
  `)
    .bind(agentId, month)
    .first()) as AgentBudgetRow | null;

  // Create budget record if not exists
  if (!budget) {
    const agent = await getAgent(env, agentId);
    const total = agent?.monthly_budget ?? 1000;

    await env.TRADER_DB.prepare(`
      INSERT INTO agent_budgets (id, agent_id, month, total_budget, spent)
      VALUES (?, ?, ?, ?, 0)
    `)
      .bind(generateId("budget"), agentId, month, total)
      .run();

    return {
      total,
      spent: 0,
      remaining: total,
    };
  }

  return {
    total: budget.total_budget,
    spent: budget.spent,
    remaining: budget.total_budget - budget.spent,
  };
}

/**
 * Update agent budget (after a trade).
 */
export async function updateAgentBudget(
  env: TraderEnv,
  agentId: string,
  amountSpent: number
): Promise<void> {
  const month = getCurrentMonth();

  // Ensure budget record exists first
  await getAgentBudget(env, agentId);

  await env.TRADER_DB.prepare(`
    UPDATE agent_budgets
    SET spent = spent + ?
    WHERE agent_id = ? AND month = ?
  `)
    .bind(amountSpent, agentId, month)
    .run();
}

/**
 * Reset all agent budgets for a new month.
 * Called by scheduled job on 1st of month.
 */
export async function resetMonthlyBudgets(env: TraderEnv): Promise<void> {
  const month = getCurrentMonth();
  const agents = await getActiveAgents(env);

  for (const agent of agents) {
    // Check if budget already exists for this month
    const existing = await env.TRADER_DB.prepare(`
      SELECT id FROM agent_budgets WHERE agent_id = ? AND month = ?
    `)
      .bind(agent.id, month)
      .first();

    if (!existing) {
      await env.TRADER_DB.prepare(`
        INSERT INTO agent_budgets (id, agent_id, month, total_budget, spent)
        VALUES (?, ?, ?, ?, 0)
      `)
        .bind(generateId("budget"), agent.id, month, agent.monthly_budget)
        .run();
    }
  }
}

// =============================================================================
// Agent Seeding
// =============================================================================

/**
 * Seed agents from code constants into database.
 */
export async function seedAgentsFromCode(env: TraderEnv): Promise<void> {
  for (const config of Object.values(AGENT_CONFIGS)) {
    // Check if already exists
    const existing = await env.TRADER_DB.prepare(`
      SELECT id FROM agents WHERE id = ?
    `)
      .bind(config.id)
      .first();

    if (!existing) {
      const now = new Date().toISOString();
      await env.TRADER_DB.prepare(`
        INSERT INTO agents (id, name, config_json, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `)
        .bind(config.id, config.name, JSON.stringify(config), now, now)
        .run();

      console.log(`Seeded agent: ${config.name} (${config.id})`);
    }
  }
}

// =============================================================================
// Agent Configuration Updates
// =============================================================================

/**
 * Update agent configuration.
 * Merges partial config with existing.
 */
export async function updateAgentConfig(
  env: TraderEnv,
  agentId: string,
  partialConfig: Partial<AgentConfig>
): Promise<boolean> {
  const existing = await getAgent(env, agentId);
  if (!existing) return false;

  const updated = { ...existing, ...partialConfig };
  const now = new Date().toISOString();

  await env.TRADER_DB.prepare(`
    UPDATE agents
    SET config_json = ?, updated_at = ?
    WHERE id = ?
  `)
    .bind(JSON.stringify(updated), now, agentId)
    .run();

  return true;
}

/**
 * Set agent active status.
 */
export async function setAgentActive(
  env: TraderEnv,
  agentId: string,
  isActive: boolean
): Promise<boolean> {
  const result = await env.TRADER_DB.prepare(`
    UPDATE agents
    SET is_active = ?, updated_at = ?
    WHERE id = ?
  `)
    .bind(isActive ? 1 : 0, new Date().toISOString(), agentId)
    .run();

  return result.meta.changes > 0;
}

// =============================================================================
// Politician Stats
// =============================================================================

/**
 * Get politician stats for scoring.
 */
export async function getPoliticianStats(
  env: TraderEnv,
  name: string
): Promise<{
  total_trades: number;
  winning_trades: number;
  win_rate: number | null;
} | null> {
  const row = await env.TRADER_DB.prepare(`
    SELECT total_trades, winning_trades, win_rate
    FROM politician_stats
    WHERE name = ?
  `)
    .bind(name)
    .first();

  if (!row) return null;

  return {
    total_trades: row.total_trades as number,
    winning_trades: row.winning_trades as number,
    win_rate: row.win_rate as number | null,
  };
}

/**
 * Upsert politician stats.
 */
export async function upsertPoliticianStats(
  env: TraderEnv,
  name: string,
  stats: {
    total_trades: number;
    winning_trades: number;
    win_rate: number | null;
  }
): Promise<void> {
  const now = new Date().toISOString();

  await env.TRADER_DB.prepare(`
    INSERT INTO politician_stats (name, total_trades, winning_trades, win_rate, last_updated)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      total_trades = excluded.total_trades,
      winning_trades = excluded.winning_trades,
      win_rate = excluded.win_rate,
      last_updated = excluded.last_updated
  `)
    .bind(name, stats.total_trades, stats.winning_trades, stats.win_rate, now)
    .run();
}

// =============================================================================
// Position Queries
// =============================================================================

/**
 * Count open positions for an agent.
 */
export async function countAgentPositions(
  env: TraderEnv,
  agentId: string
): Promise<number> {
  const result = await env.TRADER_DB.prepare(`
    SELECT COUNT(*) as count FROM positions
    WHERE agent_id = ? AND status = 'open'
  `)
    .bind(agentId)
    .first();

  return (result?.count as number) ?? 0;
}

/**
 * Count positions for a specific ticker for an agent.
 */
export async function countAgentTickerPositions(
  env: TraderEnv,
  agentId: string,
  ticker: string
): Promise<number> {
  const result = await env.TRADER_DB.prepare(`
    SELECT COUNT(*) as count FROM positions
    WHERE agent_id = ? AND ticker = ? AND status = 'open'
  `)
    .bind(agentId, ticker)
    .first();

  return (result?.count as number) ?? 0;
}

/**
 * Get all open positions for an agent.
 */
export async function getAgentPositions(
  env: TraderEnv,
  agentId: string
): Promise<any[]> {
  const results = await env.TRADER_DB.prepare(`
    SELECT * FROM positions
    WHERE agent_id = ? AND status = 'open'
    ORDER BY entry_date DESC
  `)
    .bind(agentId)
    .all();

  return results.results;
}

/**
 * Get an agent's open position for a specific ticker.
 * Returns the oldest open position if multiple exist (FIFO), null if none.
 */
export async function getAgentTickerPosition(
  env: TraderEnv,
  agentId: string,
  ticker: string
): Promise<{
  id: string;
  agent_id: string;
  ticker: string;
  shares: number;
  entry_price: number;
  entry_date: string;
} | null> {
  const row = await env.TRADER_DB.prepare(`
    SELECT id, agent_id, ticker, shares, entry_price, entry_date
    FROM positions
    WHERE agent_id = ? AND ticker = ? AND status = 'open'
    ORDER BY entry_date ASC
    LIMIT 1
  `)
    .bind(agentId, ticker)
    .first();

  if (!row) return null;

  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    ticker: row.ticker as string,
    shares: row.shares as number,
    entry_price: row.entry_price as number,
    entry_date: row.entry_date as string,
  };
}
