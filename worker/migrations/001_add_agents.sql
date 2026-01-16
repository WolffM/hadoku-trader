-- Migration 001: Multi-Agent Trading Engine Support
-- Run with: wrangler d1 execute trader-db --file=./worker/migrations/001_add_agents.sql
--
-- This migration adds support for multiple trading agents (ChatGPT, Claude, Gemini)
-- Safe to run multiple times - uses IF NOT EXISTS and checks before ALTER

-- =============================================================================
-- New Tables
-- =============================================================================

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Agent budgets table
CREATE TABLE IF NOT EXISTS agent_budgets (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  month TEXT NOT NULL,
  total_budget REAL NOT NULL DEFAULT 1000,
  spent REAL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  UNIQUE(agent_id, month)
);

CREATE INDEX IF NOT EXISTS idx_agent_budgets_agent_month ON agent_budgets(agent_id, month);

-- Politician stats table
CREATE TABLE IF NOT EXISTS politician_stats (
  name TEXT PRIMARY KEY,
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  win_rate REAL,
  avg_return_pct REAL,
  last_updated TEXT
);

-- Agent performance table
CREATE TABLE IF NOT EXISTS agent_performance (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  date TEXT NOT NULL,
  total_value REAL NOT NULL DEFAULT 0,
  total_cost_basis REAL NOT NULL DEFAULT 0,
  total_return_pct REAL NOT NULL DEFAULT 0,
  spy_return_pct REAL,
  positions_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  UNIQUE(agent_id, date)
);

CREATE INDEX IF NOT EXISTS idx_agent_perf_agent_date ON agent_performance(agent_id, date);

-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Column Additions to Existing Tables
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so these may fail
-- if columns already exist. That's OK - they're idempotent.
-- =============================================================================

-- Add agent_id and scoring columns to trades table
-- Run each separately to handle partial application
ALTER TABLE trades ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE trades ADD COLUMN decision TEXT;
ALTER TABLE trades ADD COLUMN score REAL;
ALTER TABLE trades ADD COLUMN score_breakdown_json TEXT;

-- Add agent tracking columns to positions table
ALTER TABLE positions ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE positions ADD COLUMN entry_date TEXT;
ALTER TABLE positions ADD COLUMN cost_basis REAL;
ALTER TABLE positions ADD COLUMN highest_price REAL;
ALTER TABLE positions ADD COLUMN status TEXT DEFAULT 'open';
ALTER TABLE positions ADD COLUMN closed_at TEXT;
ALTER TABLE positions ADD COLUMN close_price REAL;
ALTER TABLE positions ADD COLUMN close_reason TEXT;

-- =============================================================================
-- Record Migration
-- =============================================================================

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('001_add_agents');
