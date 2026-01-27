-- Migration: Add decision, score, score_breakdown_json columns to trades table
-- Required for multi-agent trading engine
-- Run with: wrangler d1 execute trader-db --file=./migrations/0003_add_trades_decision_columns.sql

-- Add decision column (stores agent decision: execute, skip, filter_*)
ALTER TABLE trades ADD COLUMN decision TEXT;

-- Add score column (computed score, null for pass/fail agents like Gemini)
ALTER TABLE trades ADD COLUMN score REAL;

-- Add score breakdown JSON (detailed score components)
ALTER TABLE trades ADD COLUMN score_breakdown_json TEXT;

-- Record migration
INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0003_add_trades_decision_columns');
