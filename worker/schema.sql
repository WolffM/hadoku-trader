-- Hadoku Trader D1 Schema
-- Run with: wrangler d1 execute trader-db --file=./schema.sql

-- =============================================================================
-- Signals Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  politician_name TEXT NOT NULL,
  politician_chamber TEXT NOT NULL,
  politician_party TEXT NOT NULL,
  politician_state TEXT NOT NULL,
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  disclosed_price REAL,
  disclosed_date TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  position_size TEXT NOT NULL,
  position_size_min INTEGER NOT NULL,
  position_size_max INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  source_id TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  processed_at TEXT,
  execution_decision TEXT, -- 'execute', 'skip', 'pending'
  skip_reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source);
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_scraped_at ON signals(scraped_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_source_id ON signals(source, source_id);

-- =============================================================================
-- Trades Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT REFERENCES signals(id),
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  total REAL NOT NULL,
  account TEXT,
  status TEXT NOT NULL, -- 'executed', 'pending', 'skipped', 'failed'
  error_message TEXT,
  reasoning_json TEXT, -- JSON blob with position sizing reasoning
  executed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_executed_at ON trades(executed_at);

-- =============================================================================
-- Positions Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  quantity REAL NOT NULL,
  avg_cost REAL NOT NULL,
  current_price REAL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_positions_ticker ON positions(ticker);

-- =============================================================================
-- Performance History Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS performance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  signals_value REAL NOT NULL,
  portfolio_value REAL NOT NULL,
  sp500_value REAL NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_performance_date ON performance_history(date);

-- =============================================================================
-- Config Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Insert default config
INSERT OR IGNORE INTO config (key, value) VALUES ('cash_balance', '10000');
INSERT OR IGNORE INTO config (key, value) VALUES ('monthly_budget', '5000');
INSERT OR IGNORE INTO config (key, value) VALUES ('monthly_spent', '0');
INSERT OR IGNORE INTO config (key, value) VALUES ('default_account', '');

-- =============================================================================
-- Source Stats View
-- =============================================================================

CREATE VIEW IF NOT EXISTS source_stats AS
SELECT
  s.source as name,
  COUNT(DISTINCT s.id) as total_signals,
  COUNT(DISTINCT t.id) as executed_signals,
  AVG(CASE WHEN t.status = 'executed' THEN
    ((SELECT current_price FROM positions WHERE ticker = t.ticker) - t.price) / t.price * 100
  END) as avg_return_pct
FROM signals s
LEFT JOIN trades t ON s.id = t.signal_id
GROUP BY s.source;
