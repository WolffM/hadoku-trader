-- Hadoku Trader D1 Schema v2
-- Run with: wrangler d1 execute trader-db --file=./schema.sql
--
-- BREAKING CHANGES from v1:
--   - disclosed_date -> trade_date
--   - disclosed_price -> trade_price
--   - filing_date -> disclosure_date
--   - price_at_filing -> disclosure_price
--   - Added: current_price, current_price_at, disclosure_lag_days

-- =============================================================================
-- Signals Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,

  -- Politician info
  politician_name TEXT NOT NULL,
  politician_chamber TEXT NOT NULL,
  politician_party TEXT NOT NULL,
  politician_state TEXT NOT NULL,

  -- Trade info
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,              -- 'buy', 'sell'
  asset_type TEXT NOT NULL,          -- 'stock', 'etf', 'option'
  position_size TEXT NOT NULL,
  position_size_min INTEGER NOT NULL,
  position_size_max INTEGER NOT NULL,

  -- Trade timing & price (when politician traded)
  trade_date TEXT NOT NULL,          -- When the trade was executed
  trade_price REAL,                  -- Price at time of trade

  -- Disclosure timing & price (when public learned)
  disclosure_date TEXT NOT NULL,     -- When filing became public
  disclosure_price REAL,             -- Price when disclosed
  disclosure_lag_days INTEGER,       -- Computed: disclosure_date - trade_date

  -- Current price (for portfolio valuation)
  current_price REAL,
  current_price_at TEXT,             -- When current_price was fetched

  -- Option-specific fields
  option_type TEXT,                  -- 'call' or 'put'
  strike_price REAL,
  expiration_date TEXT,              -- YYYY-MM-DD

  -- Meta fields
  source_url TEXT NOT NULL,
  source_id TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  processed_at TEXT,
  execution_decision TEXT,           -- 'execute', 'skip', 'pending'
  skip_reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source);
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_trade_date ON signals(trade_date);
CREATE INDEX IF NOT EXISTS idx_signals_disclosure_date ON signals(disclosure_date);
CREATE INDEX IF NOT EXISTS idx_signals_scraped_at ON signals(scraped_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_source_id ON signals(source, source_id);

-- =============================================================================
-- Trades Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT REFERENCES signals(id),
  agent_id TEXT,                     -- Which agent made this trade
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  total REAL NOT NULL,
  account TEXT,
  status TEXT NOT NULL,              -- 'executed', 'pending', 'skipped', 'failed'
  error_message TEXT,
  reasoning_json TEXT,               -- JSON blob with position sizing reasoning
  executed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_executed_at ON trades(executed_at);
CREATE INDEX IF NOT EXISTS idx_trades_agent_id ON trades(agent_id);

-- =============================================================================
-- Positions Table (Multi-Agent Trading Engine)
-- =============================================================================

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  shares REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_date TEXT NOT NULL,
  cost_basis REAL NOT NULL,
  current_price REAL,
  highest_price REAL NOT NULL,
  asset_type TEXT DEFAULT 'stock',
  status TEXT DEFAULT 'open',
  signal_id TEXT,
  partial_sold INTEGER DEFAULT 0,
  closed_at TEXT,
  close_price REAL,
  close_reason TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_positions_ticker ON positions(ticker);
CREATE INDEX IF NOT EXISTS idx_positions_agent_id ON positions(agent_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

-- =============================================================================
-- Performance History Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS performance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  signals_return_pct REAL NOT NULL,
  hadoku_return_pct REAL NOT NULL,
  sp500_return_pct REAL NOT NULL,
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

-- =============================================================================
-- Agents Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Agent Budgets Table
-- =============================================================================

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

-- =============================================================================
-- Politician Stats Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS politician_stats (
  name TEXT PRIMARY KEY,
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  win_rate REAL,
  avg_return_pct REAL,
  last_updated TEXT
);

-- =============================================================================
-- Agent Performance Table
-- =============================================================================

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

-- =============================================================================
-- Market Prices Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS market_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER,
  source TEXT DEFAULT 'yahoo',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_market_prices_ticker_date ON market_prices(ticker, date);
CREATE INDEX IF NOT EXISTS idx_market_prices_date ON market_prices(date);

-- =============================================================================
-- Schema Migrations Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Record this schema version
INSERT OR IGNORE INTO schema_migrations (version) VALUES ('2.0.0');
