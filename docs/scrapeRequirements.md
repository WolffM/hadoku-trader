Here's a spec you can drop into hadoku-scrape:

---

## Congress Trade Signals - Data Requirements

### Webhook Endpoint

hadoku-scrape should POST to `congress-trader` whenever a new trade is detected.

```
POST https://<congress-trader-host>/signals
Content-Type: application/json
Authorization: Bearer <shared_secret>
```

### Signal Schema

```json
{
  "source": "unusual_whales",
  "politician": {
    "name": "Nancy Pelosi",
    "chamber": "house",
    "party": "D",
    "state": "CA"
  },
  "trade": {
    "ticker": "NVDA",
    "action": "buy",
    "asset_type": "stock",
    "disclosed_price": 142.50,
    "disclosed_date": "2025-12-01",
    "filing_date": "2025-12-15",
    "position_size": "$100K-$250K",
    "position_size_min": 100000,
    "position_size_max": 250000
  },
  "meta": {
    "source_url": "https://unusualwhales.com/...",
    "source_id": "uw_12345",
    "scraped_at": "2025-12-15T14:32:00Z"
  }
}
```

### Field Definitions

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `source` | string | yes | One of: `unusual_whales`, `capitol_trades`, `quiver_quant`, `house_stock_watcher`, `senate_stock_watcher` |
| `politician.name` | string | yes | Full name as it appears on disclosure |
| `politician.chamber` | string | yes | `house` or `senate` |
| `politician.party` | string | yes | `D`, `R`, or `I` |
| `politician.state` | string | yes | Two-letter state code |
| `trade.ticker` | string | yes | Stock symbol, uppercase |
| `trade.action` | string | yes | `buy` or `sell` |
| `trade.asset_type` | string | yes | `stock`, `option`, `etf`, `bond`, `crypto` |
| `trade.disclosed_price` | float | no | Price at time of trade if available, null if not reported |
| `trade.disclosed_date` | string | yes | Date trade was executed (YYYY-MM-DD) |
| `trade.filing_date` | string | yes | Date disclosure was filed (YYYY-MM-DD) |
| `trade.position_size` | string | yes | Original range string from disclosure |
| `trade.position_size_min` | int | yes | Lower bound in dollars |
| `trade.position_size_max` | int | yes | Upper bound in dollars |
| `meta.source_url` | string | yes | Direct link to the disclosure/source |
| `meta.source_id` | string | yes | Unique ID from the source (for deduping) |
| `meta.scraped_at` | string | yes | ISO8601 timestamp when scraped |

### Position Size Ranges

Standardize to these buckets:

```
$1K-$15K       → min: 1000, max: 15000
$15K-$50K      → min: 15000, max: 50000
$50K-$100K     → min: 50000, max: 100000
$100K-$250K    → min: 100000, max: 250000
$250K-$500K    → min: 250000, max: 500000
$500K-$1M      → min: 500000, max: 1000000
$1M-$5M        → min: 1000000, max: 5000000
$5M+           → min: 5000000, max: null
```

### Sources to Scrape

| Source | URL | Priority | Notes |
|--------|-----|----------|-------|
| Unusual Whales | unusualwhales.com/congress | High | Best structured data |
| Capitol Trades | capitoltrades.com | High | Free, comprehensive |
| Quiver Quant | quiverquant.com/congresstrading | Medium | Good historical data |
| House Stock Watcher | housestockwatcher.com | Medium | House only |
| Senate Stock Watcher | senatestockwatcher.com | Medium | Senate only |

### Behavior Requirements

1. **Polling frequency** - Check sources every 15-30 minutes
2. **Deduplication** - Track `source_id` per source, don't re-send duplicates
3. **Retry on failure** - If POST to congress-trader fails, queue and retry with backoff
4. **Backfill endpoint** - Provide `GET /signals?since=<date>` so congress-trader can request missed signals on startup

### Optional: Enrichment

If feasible, add:

```json
{
  "enrichment": {
    "politician_committees": ["Finance", "Armed Services"],
    "politician_net_worth": 50000000,
    "politician_trading_history": {
      "total_trades_ytd": 45,
      "win_rate": 0.72
    }
  }
}
```

This helps with conviction scoring but isn't required for v1.

### Example Signals

**Buy signal:**
```json
{
  "source": "capitol_trades",
  "politician": {
    "name": "Tommy Tuberville",
    "chamber": "senate",
    "party": "R",
    "state": "AL"
  },
  "trade": {
    "ticker": "PLTR",
    "action": "buy",
    "asset_type": "stock",
    "disclosed_price": null,
    "disclosed_date": "2025-12-10",
    "filing_date": "2025-12-14",
    "position_size": "$50K-$100K",
    "position_size_min": 50000,
    "position_size_max": 100000
  },
  "meta": {
    "source_url": "https://capitoltrades.com/trades/...",
    "source_id": "ct_98765",
    "scraped_at": "2025-12-14T09:15:00Z"
  }
}
```

**Sell signal:**
```json
{
  "source": "unusual_whales",
  "politician": {
    "name": "Dan Crenshaw",
    "chamber": "house",
    "party": "R",
    "state": "TX"
  },
  "trade": {
    "ticker": "MSFT",
    "action": "sell",
    "asset_type": "stock",
    "disclosed_price": 425.00,
    "disclosed_date": "2025-12-05",
    "filing_date": "2025-12-12",
    "position_size": "$15K-$50K",
    "position_size_min": 15000,
    "position_size_max": 50000
  },
  "meta": {
    "source_url": "https://unusualwhales.com/congress/trade/...",
    "source_id": "uw_54321",
    "scraped_at": "2025-12-12T16:45:00Z"
  }
}
```

---

That should be everything hadoku-scrape needs. Want me to also write up the congress-trader side (the webhook receiver and validation)?