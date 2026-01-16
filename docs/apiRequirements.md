# API Requirements for hadoku-site

This document specifies the API endpoints that hadoku-site's Cloudflare Worker needs to implement for the hadoku-trader dashboard.

## Data Flow

```
hadoku-scraper ──(every 8hrs)──► hadoku-site worker ──► D1 database
                                                              │
                                                              ▼
                                         hadoku-trader dashboard (fetches via REST)
```

## Scheduled Task

**Trigger**: Every 8 hours (cron: `0 */8 * * *`)

**Action**: Fetch data package from hadoku-scraper and store in D1

## REST API Endpoints

### GET /api/trader/signals

Returns all congressional trade signals.

**Response:**
```json
{
  "signals": [
    {
      "id": "string",
      "source": "unusual_whales|capitol_trades|quiver_quant|house_stock_watcher|senate_stock_watcher",
      "politician": {
        "name": "Nancy Pelosi",
        "chamber": "house|senate",
        "party": "D|R|I",
        "state": "CA"
      },
      "trade": {
        "ticker": "NVDA",
        "action": "buy|sell",
        "asset_type": "stock|option|etf",
        "disclosed_price": 142.50,
        "disclosed_date": "2025-12-01",
        "filing_date": "2025-12-15",
        "position_size": "$100K-$250K",
        "position_size_min": 100000,
        "position_size_max": 250000
      },
      "meta": {
        "source_url": "https://...",
        "source_id": "uw_12345",
        "scraped_at": "2025-12-15T14:32:00Z"
      }
    }
  ],
  "last_updated": "2025-12-15T14:32:00Z"
}
```

### GET /api/trader/performance

Returns performance data for signals, portfolio, and benchmarks.

**Response:**
```json
{
  "signals_performance": {
    "total_return_pct": 15.5,
    "mtd_return_pct": 2.3,
    "ytd_return_pct": 15.5,
    "history": [
      { "date": "2025-12-01", "value": 10000 },
      { "date": "2025-12-02", "value": 10150 }
    ]
  },
  "portfolio_performance": {
    "total_value": 12500,
    "total_return_pct": 25.0,
    "mtd_return_pct": 3.1,
    "ytd_return_pct": 25.0,
    "history": [
      { "date": "2025-12-01", "value": 10000 },
      { "date": "2025-12-02", "value": 10200 }
    ]
  },
  "sp500_performance": {
    "total_return_pct": 12.0,
    "mtd_return_pct": 1.5,
    "ytd_return_pct": 12.0,
    "history": [
      { "date": "2025-12-01", "value": 10000 },
      { "date": "2025-12-02", "value": 10120 }
    ]
  },
  "last_updated": "2025-12-15T14:32:00Z"
}
```

### GET /api/trader/portfolio

Returns current portfolio positions.

**Response:**
```json
{
  "positions": [
    {
      "ticker": "NVDA",
      "quantity": 10,
      "avg_cost": 140.00,
      "current_price": 150.00,
      "market_value": 1500.00,
      "unrealized_pnl": 100.00,
      "unrealized_pnl_pct": 7.14
    }
  ],
  "cash": 5000.00,
  "total_value": 15500.00,
  "last_updated": "2025-12-15T14:32:00Z"
}
```

### GET /api/trader/trades

Returns trade history with reasoning.

**Response:**
```json
{
  "trades": [
    {
      "id": "string",
      "date": "2025-12-10T10:30:00Z",
      "ticker": "NVDA",
      "action": "buy",
      "quantity": 10,
      "price": 140.00,
      "total": 1400.00,
      "signal_id": "uw_12345",
      "reasoning": {
        "politician": "Nancy Pelosi",
        "source_count": 2,
        "conviction_multiplier": 1.25,
        "priced_in_factor": 0.85,
        "position_size_tier": "$100K-$250K"
      },
      "status": "executed|pending|skipped"
    }
  ],
  "last_updated": "2025-12-15T14:32:00Z"
}
```

### GET /api/trader/sources

Returns leaderboard of signal sources.

**Response:**
```json
{
  "sources": [
    {
      "name": "unusual_whales",
      "total_signals": 150,
      "executed_signals": 120,
      "avg_return_pct": 8.5,
      "win_rate": 0.65
    }
  ],
  "last_updated": "2025-12-15T14:32:00Z"
}
```

### POST /api/trader/execute

Forwards trade execution request to local PM2 service via cloudflared tunnel.

**Request:**
```json
{
  "ticker": "NVDA",
  "action": "buy",
  "quantity": 10,
  "account": "Z12345678",
  "dry_run": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Trade executed successfully",
  "order_id": "string"
}
```

## D1 Schema

```sql
CREATE TABLE signals (
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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE performance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  signals_value REAL NOT NULL,
  portfolio_value REAL NOT NULL,
  sp500_value REAL NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT REFERENCES signals(id),
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL,
  reasoning_json TEXT,
  executed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  quantity REAL NOT NULL,
  avg_cost REAL NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## Local Trade Service

The local PM2 service should expose a simple HTTP endpoint that hadoku-site can call via the cloudflared tunnel:

```
POST /execute-trade
{
  "ticker": "NVDA",
  "action": "buy",
  "quantity": 10,
  "account": "Z12345678",
  "dry_run": true
}
```

This service uses the fidelity-api Python library to execute the actual trade.
