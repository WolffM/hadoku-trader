# Hadoku Scraper Requirements for Multi-Agent Engine

**Version:** 2.0
**Purpose:** Define what hadoku-scraper must provide to support three trading agents (ChatGPT, Claude, Gemini)

---

## Overview

The scraper needs to provide:
1. **Congressional trade signals** - Core data from disclosure sources
2. **Market data** - Current prices for scoring and position monitoring
3. **Historical prices** - For politician win rate calculation
4. **Titan portfolio data** - For Gemini's Consensus Core basket (semi-annual)

---

## 1. Signal Schema (Updated)

### Webhook Endpoint

```
POST https://<trader-worker-host>/api/signals
Content-Type: application/json
Authorization: Bearer <SCRAPER_API_KEY>
```

### Signal Payload

```typescript
interface Signal {
  // Source identification
  source: SignalSource;

  // Politician data
  politician: {
    name: string;              // Full name as on disclosure
    chamber: 'house' | 'senate';
    party: 'D' | 'R' | 'I';
    state: string;             // Two-letter code
  };

  // Trade data
  trade: {
    ticker: string;            // Uppercase symbol
    action: 'buy' | 'sell';
    asset_type: 'stock' | 'option' | 'etf' | 'bond' | 'crypto';

    // Pricing (CRITICAL for scoring)
    disclosed_price: number | null;       // Price at trade execution
    price_at_filing: number | null;       // NEW: Price when filing was made public

    // Dates
    disclosed_date: string;    // YYYY-MM-DD - when politician traded
    filing_date: string;       // YYYY-MM-DD - when disclosure was filed

    // Position size
    position_size: string;     // Original range string "$100K-$250K"
    position_size_min: number; // Lower bound in dollars
    position_size_max: number; // Upper bound in dollars

    // Option-specific (if asset_type === 'option')
    option_type?: 'call' | 'put';
    strike_price?: number;
    expiration_date?: string;  // YYYY-MM-DD
  };

  // Metadata
  meta: {
    source_url: string;        // Direct link to disclosure
    source_id: string;         // Unique ID from source (for deduping)
    scraped_at: string;        // ISO8601 timestamp
  };
}

type SignalSource =
  | 'unusual_whales'
  | 'capitol_trades'
  | 'quiver_quant'
  | 'house_stock_watcher'
  | 'senate_stock_watcher';
```

### New/Updated Fields

| Field | Status | Why Needed |
|-------|--------|------------|
| `trade.disclosed_price` | Existing, **now critical** | Price movement scoring for ChatGPT/Claude |
| `trade.price_at_filing` | **NEW** | Baseline for "priced in" calculation |
| `trade.option_type` | **NEW** | ChatGPT values options higher (+0.12 conviction) |
| `trade.strike_price` | **NEW** | Option position analysis |
| `trade.expiration_date` | **NEW** | ChatGPT soft-stop logic (10 days for options) |

### Disclosed Price Requirements

**This is now critical for scoring.** If source doesn't provide:

1. **Best effort:** Fetch historical close price for `disclosed_date` from Yahoo Finance
2. **If unavailable:** Set to `null` - engine will use `price_at_filing` as fallback
3. **Log warning:** Track which sources frequently lack prices

### Price at Filing

New field - populate by:
1. Fetching close price on `filing_date` from Yahoo Finance
2. If filing is today, use current price
3. This is the baseline the engine uses for "how much has it already moved?"

---

## 2. Market Data Endpoint

The trader worker needs current prices for:
- Scoring new signals (price change since disclosed)
- Monitoring positions (stop-loss, take-profit)
- Daily performance snapshots

### Required Endpoint

```
GET https://<scraper-host>/api/market/quotes?tickers=AAPL,MSFT,NVDA
Authorization: Bearer <API_KEY>
```

### Response Schema

```typescript
interface MarketQuotesResponse {
  quotes: {
    ticker: string;
    price: number;           // Current/last price
    change_pct: number;      // Daily change %
    volume: number;          // Daily volume
    timestamp: string;       // ISO8601 - when quote was fetched
  }[];

  // Benchmark
  sp500: {
    price: number;
    change_pct: number;
    ytd_return_pct: number;
  };
}
```

### Requirements

| Requirement | Value |
|-------------|-------|
| Refresh frequency | Every 5 minutes during market hours |
| Staleness threshold | Quotes older than 15 min = stale |
| After hours | Return last close price |
| Batch size | Up to 100 tickers per request |

---

## 3. Historical Price Endpoint

Needed for:
- Calculating politician win rates (price at filing_date + 90 days)
- Backfilling `price_at_filing` for old signals
- Performance chart data

### Required Endpoint

```
GET https://<scraper-host>/api/market/historical
  ?ticker=AAPL
  &start_date=2025-01-01
  &end_date=2025-12-31
Authorization: Bearer <API_KEY>
```

### Response Schema

```typescript
interface HistoricalPricesResponse {
  ticker: string;
  prices: {
    date: string;      // YYYY-MM-DD
    open: number;
    high: number;
    low: number;
    close: number;     // This is what we use
    volume: number;
  }[];
}
```

### Single-Date Convenience

```
GET https://<scraper-host>/api/market/price?ticker=AAPL&date=2025-06-15
```

Returns just the close price for that date.

---

## 4. Politician Stats Endpoint (Enhancement)

For politician skill scoring. **Optional for v1** - engine will use default score if unavailable.

### Required Endpoint

```
GET https://<scraper-host>/api/politicians/:name/stats
Authorization: Bearer <API_KEY>
```

### Response Schema

```typescript
interface PoliticianStatsResponse {
  name: string;
  chamber: 'house' | 'senate';
  party: 'D' | 'R' | 'I';

  // Trading stats
  total_trades: number;       // All-time
  trades_ytd: number;

  // Performance (if calculable)
  win_rate?: number;          // % of trades that hit +5% within 90 days
  avg_return?: number;        // Average return at 90 days

  // Volume
  total_volume_ytd: number;   // Dollar amount traded YTD

  // Last activity
  last_trade_date: string;

  // Committee memberships (for future use)
  committees?: string[];
}
```

---

## 5. Titan Portfolio Endpoint (For Gemini)

Semi-annual query to determine Consensus Core basket.

### Required Endpoint

```
GET https://<scraper-host>/api/politicians/:name/holdings
Authorization: Bearer <API_KEY>
```

### Response Schema

```typescript
interface PoliticianHoldingsResponse {
  name: string;
  as_of_date: string;

  holdings: {
    ticker: string;
    asset_type: 'stock' | 'option' | 'etf';
    estimated_value_min: number;
    estimated_value_max: number;
    last_action: 'buy' | 'sell' | 'hold';
    last_action_date: string;
  }[];
}
```

### Required Politicians (Gemini's Titans)

```
Nancy Pelosi
Mark Green
Michael McCaul
Ro Khanna
Rick Larsen
```

---

## 6. Source Priority & Quality

### Source Ranking (for scoring)

| Source | Quality Score | Priority | Notes |
|--------|--------------|----------|-------|
| quiver_quant | 1.00 | High | Best structured data |
| capitol_trades | 0.90 | High | Comprehensive, free |
| unusual_whales | 0.85 | High | Good coverage |
| house_stock_watcher | 0.80 | Medium | House only |
| senate_stock_watcher | 0.80 | Medium | Senate only |

### Scraping Requirements Per Source

| Source | Fields Typically Available | Missing Fields |
|--------|---------------------------|----------------|
| Quiver Quant | All except option details | option_type, strike |
| Capitol Trades | All core fields | disclosed_price often null |
| Unusual Whales | All including options | - |
| House/Senate Watcher | Core fields only | disclosed_price, options |

### Fallback Strategy

If a field is missing from source:
1. `disclosed_price` → Fetch from Yahoo Finance historical
2. `price_at_filing` → Fetch from Yahoo Finance historical
3. `option details` → Set to null, log warning
4. `position_size` → Use midpoint if only one value given

---

## 7. Cross-Confirmation Detection

The engine gives bonus points when multiple sources report the same trade.

### Deduplication Logic

Same trade = same `(politician_name, ticker, action, disclosed_date)`

### What Scraper Should Do

1. **Still send duplicates** - The trader worker handles deduping
2. **Include source_id** - So worker can track confirmations
3. **Timestamp accurately** - `scraped_at` should be when YOU scraped it

### What Worker Will Do

```
Signal arrives → Check if (politician, ticker, action, date) exists within 7 days
  → If yes: increment confirmation_count on existing signal
  → If no: create new signal
```

---

## 8. Polling & Delivery Requirements

### Polling Frequency

| Source | Frequency | Notes |
|--------|-----------|-------|
| All sources | Every 15 minutes | During market hours |
| All sources | Every 30 minutes | After hours |
| Weekend | Every 2 hours | Disclosures can be filed anytime |

### Delivery Method

**Option A: Webhook (Preferred)**
```
POST https://<trader-worker>/api/signals
```
- Push each signal as discovered
- Retry with exponential backoff on failure
- Max 3 retries, then dead-letter queue

**Option B: Pull (Backup)**
```
GET https://<scraper>/api/signals?since=<timestamp>
```
- Worker can poll for missed signals
- Return signals scraped since timestamp
- Paginated, max 100 per page

### Exactly-Once Delivery

Include `meta.source_id` - worker will reject duplicates from same source.

---

## 9. Data Quality Checks

Scraper should validate before sending:

| Check | Action if Failed |
|-------|-----------------|
| `ticker` is valid symbol | Skip signal, log error |
| `disclosed_date` <= `filing_date` | Swap dates, log warning |
| `disclosed_date` not in future | Skip signal, log error |
| `position_size_min` <= `position_size_max` | Swap values, log warning |
| `politician.name` is not empty | Skip signal, log error |
| `politician.party` is D/R/I | Default to 'I', log warning |

---

## 10. Backfill Requirements

For politician win rate calculation, we need historical data.

### Initial Backfill

```
GET https://<scraper>/api/signals/backfill?start_date=2023-01-01
```

- Return all signals from `start_date` to present
- Paginated (1000 per page)
- Include `price_at_filing` and historical prices where possible

### Historical Price Backfill

For each signal older than 90 days, we need:
- Price at `filing_date`
- Price at `filing_date + 90 days`

This can be computed by scraper or fetched by worker from Yahoo Finance.

---

## 11. API Summary

| Endpoint | Method | Purpose | Priority |
|----------|--------|---------|----------|
| `/api/signals` | POST | Push new signals | **Required** |
| `/api/signals` | GET | Pull signals since timestamp | **Required** |
| `/api/signals/backfill` | GET | Historical backfill | **Required** |
| `/api/market/quotes` | GET | Current prices (batch) | **Required** |
| `/api/market/price` | GET | Single historical price | **Required** |
| `/api/market/historical` | GET | Price range | Nice-to-have |
| `/api/politicians/:name/stats` | GET | Trading stats | Nice-to-have |
| `/api/politicians/:name/holdings` | GET | Current holdings | Nice-to-have |

---

## 12. Schema Changes Summary

### Fields to Add

| Field | Type | Location | Why |
|-------|------|----------|-----|
| `trade.price_at_filing` | number \| null | Signal | Baseline for price movement |
| `trade.option_type` | 'call' \| 'put' | Signal | Option scoring |
| `trade.strike_price` | number | Signal | Option analysis |
| `trade.expiration_date` | string | Signal | Option time exit |

### Endpoints to Add

| Endpoint | Priority | Why |
|----------|----------|-----|
| `GET /api/market/quotes` | Required | Position monitoring |
| `GET /api/market/price` | Required | Historical lookups |
| `GET /api/signals/backfill` | Required | Win rate calculation |

### Behavior Changes

| Change | Why |
|--------|-----|
| Populate `disclosed_price` aggressively | Critical for scoring |
| Add `price_at_filing` to all signals | Baseline for price movement |
| Support batch quote fetching | Position monitoring efficiency |

---

## 13. Example Updated Signal

```json
{
  "source": "quiver_quant",
  "politician": {
    "name": "Nancy Pelosi",
    "chamber": "house",
    "party": "D",
    "state": "CA"
  },
  "trade": {
    "ticker": "NVDA",
    "action": "buy",
    "asset_type": "option",
    "disclosed_price": 142.50,
    "price_at_filing": 148.75,
    "disclosed_date": "2025-12-01",
    "filing_date": "2025-12-15",
    "position_size": "$100K-$250K",
    "position_size_min": 100000,
    "position_size_max": 250000,
    "option_type": "call",
    "strike_price": 150.00,
    "expiration_date": "2026-03-21"
  },
  "meta": {
    "source_url": "https://quiverquant.com/congress/...",
    "source_id": "qq_2025_12345",
    "scraped_at": "2025-12-15T14:32:00Z"
  }
}
```

---

## 14. Implementation Checklist

### Phase 1: Core Updates
- [ ] Add `price_at_filing` to signal schema
- [ ] Fetch historical prices for `disclosed_price` when missing
- [ ] Implement `GET /api/market/quotes` batch endpoint
- [ ] Implement `GET /api/market/price` single-date endpoint

### Phase 2: Backfill
- [ ] Implement `GET /api/signals/backfill` endpoint
- [ ] Backfill historical signals from 2023-01-01
- [ ] Compute `price_at_filing` for historical signals

### Phase 3: Enhancements
- [ ] Add option fields (type, strike, expiration)
- [ ] Implement politician stats endpoint
- [ ] Implement politician holdings endpoint

### Phase 4: Monitoring
- [ ] Track source reliability (% of signals with prices)
- [ ] Alert on scraping failures
- [ ] Dashboard for signal volume by source
