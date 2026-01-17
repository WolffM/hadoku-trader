-- Migration 002: Add option fields and price_at_filing to signals table
-- Run with: wrangler d1 execute trader-db --file=./migrations/002_add_option_fields.sql

-- Add price_at_filing column (price on the filing/disclosure date)
ALTER TABLE signals ADD COLUMN price_at_filing REAL;

-- Add option-specific columns
ALTER TABLE signals ADD COLUMN option_type TEXT; -- 'call' or 'put'
ALTER TABLE signals ADD COLUMN strike_price REAL;
ALTER TABLE signals ADD COLUMN expiration_date TEXT; -- YYYY-MM-DD

-- Record this migration
INSERT INTO schema_migrations (version) VALUES ('002_add_option_fields');
