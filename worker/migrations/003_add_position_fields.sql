-- Migration 003: Add monitoring fields to positions table
-- Run with: wrangler d1 execute trader-db --file=./migrations/003_add_position_fields.sql

-- Add signal_id to link position back to triggering signal
ALTER TABLE positions ADD COLUMN signal_id TEXT;

-- Add asset_type for soft stop calculations (stock vs option)
ALTER TABLE positions ADD COLUMN asset_type TEXT DEFAULT 'stock';

-- Add partial_sold flag for take-profit tier tracking
ALTER TABLE positions ADD COLUMN partial_sold INTEGER DEFAULT 0;

-- Add agent_id to track which agent owns this position
ALTER TABLE positions ADD COLUMN agent_id TEXT;

-- Add status for position lifecycle
ALTER TABLE positions ADD COLUMN status TEXT DEFAULT 'open';

-- Add close tracking fields
ALTER TABLE positions ADD COLUMN closed_at TEXT;
ALTER TABLE positions ADD COLUMN close_price REAL;
ALTER TABLE positions ADD COLUMN close_reason TEXT;

-- Add highest_price for trailing stop-loss
ALTER TABLE positions ADD COLUMN highest_price REAL;

-- Add entry_date for time-based exit
ALTER TABLE positions ADD COLUMN entry_date TEXT;

-- Create index for agent_id lookups
CREATE INDEX IF NOT EXISTS idx_positions_agent_id ON positions(agent_id);

-- Create index for status lookups
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

-- Record this migration
INSERT INTO schema_migrations (version) VALUES ('003_add_position_fields');
