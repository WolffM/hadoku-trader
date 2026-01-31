# Hadoku Scraper Integration Guide

## Overview

The trader system is designed to ingest signals from **any source** that conforms to the signal schema. The ingestion process is fully abstract - you don't need to modify trader code when adding new sources.

---

## Signal Schema

Every signal must conform to this structure:

```typescript
interface Signal {
  source: string // e.g., "capitol_trades", "unusual_whales", "quiver_quant"
  politician: {
    name: string // "Nancy Pelosi"
    chamber: 'house' | 'senate'
    party: 'D' | 'R' | 'I'
    state: string // "CA"
  }
  trade: {
    ticker: string // "NVDA"
    action: 'buy' | 'sell'
    asset_type: 'stock' | 'option' | 'etf' | 'bond' | 'crypto'
    trade_price: number | null // ⚠️ CRITICAL - price at trade time
    disclosure_price: number | null // price when filing was disclosed
    trade_date: string // "2024-06-15" - when trade happened
    disclosure_date: string // "2024-07-01" - when publicly filed
    position_size: string // "$1,001 - $15,000"
    position_size_min: number // 1001
    position_size_max: number // 15000
    // Option-specific (null for stocks)
    option_type: 'call' | 'put' | null
    strike_price: number | null
    expiration_date: string | null // "2024-12-20"
  }
  meta: {
    source_url: string // URL to the original filing/page
    source_id: string // Unique ID from source (for deduplication)
    scraped_at: string // ISO8601 timestamp
  }
}
```

---

## Critical: `trade_price`

**This field is essential for backtesting/simulation.**

Without `trade_price`, we cannot:

- Calculate entry prices for simulated trades
- Measure P&L performance
- Run meaningful backtests

### How to Get `trade_price`

The scraper should:

1. **Use the trade date** (`trade_date`) to look up historical price
2. **Call a market data API** (Yahoo Finance, Alpha Vantage, etc.)
3. **Get the closing price** on that date (or open if same-day)

Example enrichment logic:

```python
async def enrich_signal_with_price(signal: dict) -> dict:
    """Add trade_price by looking up historical market data."""
    ticker = signal["trade"]["ticker"]
    trade_date = signal["trade"]["trade_date"]

    # Get historical price for that date
    price = await get_historical_close(ticker, trade_date)

    signal["trade"]["trade_price"] = price
    return signal

async def get_historical_close(ticker: str, date: str) -> float | None:
    """Fetch closing price for ticker on given date."""
    # Use yfinance, Alpha Vantage, or similar
    import yfinance as yf

    stock = yf.Ticker(ticker)
    hist = stock.history(start=date, end=add_days(date, 1))

    if hist.empty:
        return None

    return float(hist["Close"].iloc[0])
```

---

## Ingestion Endpoints

### Single Signal: `POST /api/trader/signals`

```bash
curl -X POST https://hadoku.me/api/trader/signals \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $SCRAPER_API_KEY" \
  -d '{
    "source": "capitol_trades",
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
      "trade_price": 125.50,
      "disclosure_price": 142.30,
      "trade_date": "2024-06-15",
      "disclosure_date": "2024-07-01",
      "position_size": "$1,001 - $15,000",
      "position_size_min": 1001,
      "position_size_max": 15000,
      "option_type": null,
      "strike_price": null,
      "expiration_date": null
    },
    "meta": {
      "source_url": "https://efdsearch.senate.gov/...",
      "source_id": "ct_12345678",
      "scraped_at": "2024-07-02T10:30:00Z"
    }
  }'
```

Response:

```json
{
  "success": true,
  "message": "Signal received",
  "id": "sig_abc123"
}
```

### Batch Backfill: `POST /api/trader/signals/backfill`

For historical data ingestion:

```bash
curl -X POST https://hadoku.me/api/trader/signals/backfill \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $SCRAPER_API_KEY" \
  -d '{
    "event": "backfill.batch",
    "job_id": "backfill_2024_q1",
    "batch_number": 1,
    "source": "capitol_trades",
    "signals": [
      { ... signal 1 ... },
      { ... signal 2 ... },
      { ... signal N ... }
    ],
    "is_last_batch": false
  }'
```

Send `"event": "backfill.completed"` when done:

```json
{
  "event": "backfill.completed",
  "job_id": "backfill_2024_q1"
}
```

---

## Adding New Sources

The trader system accepts **any source string**. Just use a consistent identifier:

```python
# Supported sources (add more as needed)
SOURCES = [
    "capitol_trades",      # capitoltrades.com
    "unusual_whales",      # unusualwhales.com
    "quiver_quant",        # quiverquant.com
    "house_stock_watcher", # housestockwatcher.com
    "senate_stock_watcher", # senatestockwatcher.com
    "finviz_insider",      # finviz.com insider trades
    "sec_form4",           # Direct SEC Form 4 filings
    # Add your own...
]
```

No trader-side changes needed. Just ensure:

1. `source` field is consistent (same string for same source)
2. `source_id` is unique within that source (for deduplication)

---

## Expanding Historical Range

### Target: 2+ Years of Data

The scraper should fetch signals going back at least **2 years** (ideally 5+) to enable meaningful backtesting.

### Recommended Approach

1. **Capitol Trades** - Has data back to 2019+
   - Paginate through all historical trades
   - API: `https://www.capitoltrades.com/trades?page=N`

2. **House Stock Watcher** - STOCK Act filings since 2012
   - Bulk download available: `https://house-stock-watcher.netlify.app/`
   - JSON API endpoint

3. **Senate Stock Watcher** - Similar to House
   - `https://senate-stock-watcher.netlify.app/`

4. **Quiver Quant** - Aggregates multiple sources
   - May require API key
   - Good for cross-referencing

5. **SEC EDGAR** - Primary source (Form 4 filings)
   - Most complete but requires parsing
   - `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=4`

### Backfill Strategy

```python
async def run_historical_backfill():
    """Backfill all historical data."""

    sources = [
        ("capitol_trades", fetch_capitol_trades_history),
        ("house_stock_watcher", fetch_house_stock_watcher_history),
        ("senate_stock_watcher", fetch_senate_stock_watcher_history),
    ]

    for source_name, fetcher in sources:
        print(f"Backfilling {source_name}...")

        # Fetch all historical signals
        signals = await fetcher(
            start_date="2020-01-01",  # Go back far
            end_date="2025-01-15"
        )

        # Enrich with prices
        enriched = []
        for signal in signals:
            signal = await enrich_signal_with_price(signal)
            enriched.append(signal)

        # Send in batches
        batch_size = 100
        for i in range(0, len(enriched), batch_size):
            batch = enriched[i:i+batch_size]
            await send_backfill_batch(
                job_id=f"backfill_{source_name}",
                batch_number=i // batch_size + 1,
                source=source_name,
                signals=batch,
                is_last_batch=(i + batch_size >= len(enriched))
            )

        print(f"  Sent {len(enriched)} signals")

    print("Backfill complete!")
```

---

## Price Enrichment Service

Since many sources don't provide trade prices, the scraper should run a price enrichment step:

```python
import yfinance as yf
from datetime import datetime, timedelta
import asyncio

class PriceEnricher:
    def __init__(self):
        self.cache = {}  # (ticker, date) -> price

    async def enrich_batch(self, signals: list[dict]) -> list[dict]:
        """Enrich a batch of signals with historical prices."""

        # Collect unique (ticker, date) pairs
        lookups = set()
        for s in signals:
            ticker = s["trade"]["ticker"]
            date = s["trade"]["trade_date"]
            if s["trade"]["trade_price"] is None:
                lookups.add((ticker, date))

        # Batch fetch prices
        await self._fetch_prices(lookups)

        # Apply to signals
        for s in signals:
            if s["trade"]["trade_price"] is None:
                key = (s["trade"]["ticker"], s["trade"]["trade_date"])
                s["trade"]["trade_price"] = self.cache.get(key)

        return signals

    async def _fetch_prices(self, lookups: set[tuple[str, str]]):
        """Fetch historical prices for all lookups."""

        # Group by ticker for efficient fetching
        by_ticker = {}
        for ticker, date in lookups:
            if ticker not in by_ticker:
                by_ticker[ticker] = []
            by_ticker[ticker].append(date)

        # Fetch each ticker's history
        for ticker, dates in by_ticker.items():
            min_date = min(dates)
            max_date = max(dates)

            try:
                stock = yf.Ticker(ticker)
                hist = stock.history(
                    start=min_date,
                    end=(datetime.fromisoformat(max_date) + timedelta(days=5)).isoformat()[:10]
                )

                for date in dates:
                    try:
                        price = float(hist.loc[date]["Close"])
                        self.cache[(ticker, date)] = price
                    except (KeyError, IndexError):
                        # Market was closed, try nearby dates
                        self.cache[(ticker, date)] = self._find_nearest_price(hist, date)

            except Exception as e:
                print(f"Failed to fetch {ticker}: {e}")

    def _find_nearest_price(self, hist, target_date: str) -> float | None:
        """Find nearest available price to target date."""
        if hist.empty:
            return None

        target = datetime.fromisoformat(target_date)
        hist.index = hist.index.tz_localize(None)

        # Find closest date
        diffs = abs(hist.index - target)
        closest_idx = diffs.argmin()

        if diffs[closest_idx].days <= 5:  # Within 5 days
            return float(hist.iloc[closest_idx]["Close"])

        return None
```

---

## Deduplication

The trader API handles deduplication by `(source, source_id)`.

**Important:** Generate stable, unique `source_id` values:

```python
def generate_source_id(source: str, signal: dict) -> str:
    """Generate unique, stable ID for a signal."""

    # Option 1: Use source's native ID if available
    if "id" in signal:
        return f"{source}_{signal['id']}"

    # Option 2: Hash key fields
    import hashlib
    key = f"{signal['politician']['name']}_{signal['trade']['ticker']}_{signal['trade']['trade_date']}_{signal['trade']['action']}"
    hash_suffix = hashlib.md5(key.encode()).hexdigest()[:8]
    return f"{source}_{hash_suffix}"
```

---

## Summary: Scraper Requirements

| Requirement          | Priority    | Notes                                 |
| -------------------- | ----------- | ------------------------------------- |
| **trade_price**      | 🔴 Critical | Fetch historical price for trade date |
| **2+ year history**  | 🔴 Critical | Enable meaningful backtesting         |
| **Multiple sources** | 🟡 High     | Cross-reference for higher conviction |
| **Batch backfill**   | 🟡 High     | Efficient historical ingestion        |
| **Stable source_id** | 🟢 Medium   | For deduplication                     |
| **Option details**   | 🟢 Medium   | strike_price, expiration_date         |

### Quick Start Checklist

- [ ] Implement price enrichment using yfinance or similar
- [ ] Add historical scraping for Capitol Trades (2020-present)
- [ ] Add House Stock Watcher integration
- [ ] Add Senate Stock Watcher integration
- [ ] Run full backfill with price enrichment
- [ ] Set up scheduled scraping (every 8 hours) for new signals

---

## Testing

After backfilling, verify the data was ingested correctly:

```bash
# Check signal count
curl https://hadoku.me/api/trader/signals | jq '.signals | length'

# Check source distribution
curl https://hadoku.me/api/trader/sources
```

For backtesting/simulation, use the test files locally:

```bash
cd worker
pnpm test simulation.test.ts
```

Expected simulation results:

- `signals_processed` > 100 (many signals with prices)
- `closedPositions` > 0 (positions that exited)
- Meaningful return/drawdown metrics

See `docs/SIMULATION_FINDINGS.md` for backtesting methodology.
