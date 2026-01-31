# End-to-End Production Test Signals

This document contains test signals for validating the full trading pipeline in production.

**Last Updated**: 2026-01-31
**Test Data Source**: signals_45d.json (274 signals)

## Current Top 10 Politicians (24-month window)

Computed dynamically from historical data using the same algorithm as production:

| Rank | Politician             | Party |
| ---- | ---------------------- | ----- |
| 1    | Rob Bresnahan          | R     |
| 2    | Bill Keating           | D     |
| 3    | Kathy Manning          | D     |
| 4    | David Taylor           | R     |
| 5    | Cleo Fields            | D     |
| 6    | Shelley Moore Capito   | R     |
| 7    | John Fetterman         | D     |
| 8    | James Comer            | R     |
| 9    | Marjorie Taylor Greene | R     |
| 10   | Ashley Moody           | R     |

**NOTE**: This list is computed from `trader-db-export.json` using a 24-month rolling window and min 15 trades. Production computes from the D1 database, so the actual Top 10 may differ.

---

## Expected ChatGPT+Top10 Results (45-day replay)

With the dynamic Top 10 filter applied, ChatGPT should execute **1 trade**:

| #   | Date       | Signal ID      | Ticker | Politician  | Score | Size   | Action |
| --- | ---------- | -------------- | ------ | ----------- | ----- | ------ | ------ |
| 1   | 2026-01-19 | ct_20003794830 | GOOGL  | Cleo Fields | 0.574 | $49.46 | BUY    |

**Summary**: 268 signals processed, 1 executed, 267 skipped

---

**IMPORTANT**: Before running these tests:

1. Verify `DRY_RUN = true` in `worker/src/agents/tradingConfig.ts` (line 19)
2. Or set `ENABLE_LIVE_TRADING=false` in environment
3. Redeploy the trader-worker package if changed
4. Ensure cloudflared tunnel is active
5. Ensure local trader-worker (PM2) is running

---

## Pre-Flight Checklist

```bash
# 1. Verify DRY_RUN is true (in hadoku-trader repo)
grep "DRY_RUN = " worker/src/agents/tradingConfig.ts
# Should show: export const DRY_RUN = true;

# 2. Check health endpoint
curl -X GET "https://hadoku-site.wolffm.workers.dev/api/trader/health"

# 3. Initialize agent budgets for current month (if needed)
curl -X GET "https://hadoku-site.wolffm.workers.dev/api/trader/agents"
```

---

## Test Signals JSON

Use this complete JSON file to send all test signals in sequence:

```json
{
  "test_suite": "e2e_production_validation",
  "version": "1.0",
  "created_at": "2026-01-26T18:00:00Z",
  "signals": [
    {
      "test_id": "test_01_buy_top10_passes",
      "description": "BUY signal from Top 10 politician - should execute for ChatGPT (Cleo Fields is in Top 10)",
      "expected": {
        "chatgpt": { "action": "execute", "reason": "Cleo Fields in Top 10, score ~0.57" },
        "claude": { "action": "execute", "reason": "Score passes threshold" },
        "gemini": { "action": "skip", "reason": "Cleo Fields not in Titan whitelist" }
      },
      "signal": {
        "source": "capitol_trades",
        "politician": {
          "name": "Cleo Fields",
          "chamber": "house",
          "party": "D",
          "state": "LA"
        },
        "trade": {
          "ticker": "GOOGL",
          "action": "buy",
          "asset_type": "stock",
          "trade_date": "2026-01-17",
          "trade_price": 313.51,
          "disclosure_date": "2026-01-19",
          "disclosure_price": 330.0,
          "current_price": 335.0,
          "current_price_at": "2026-01-31T16:00:00Z",
          "position_size": "$15,001-$50,000",
          "position_size_min": 15001,
          "position_size_max": 50000,
          "option_type": null,
          "strike_price": null,
          "expiration_date": null
        },
        "meta": {
          "source_url": "https://capitoltrades.com/test/e2e-01",
          "source_id": "e2e_test_01_buy_top10_20260131",
          "scraped_at": "2026-01-31T17:00:00Z"
        }
      }
    },
    {
      "test_id": "test_01b_buy_pelosi_skip_top10",
      "description": "BUY signal from Nancy Pelosi - ChatGPT SKIP (NOT in Top 10), Gemini EXECUTE (Titan)",
      "expected": {
        "chatgpt": { "action": "skip", "reason": "Nancy Pelosi NOT in current Top 10" },
        "claude": { "action": "execute", "reason": "Claude accepts all politicians" },
        "gemini": { "action": "execute", "reason": "Nancy Pelosi is Titan" }
      },
      "signal": {
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
          "trade_date": "2026-01-29",
          "trade_price": 140.0,
          "disclosure_date": "2026-01-30",
          "disclosure_price": 142.0,
          "current_price": 143.5,
          "current_price_at": "2026-01-31T16:00:00Z",
          "position_size": "$250,001-$500,000",
          "position_size_min": 250001,
          "position_size_max": 500000,
          "option_type": null,
          "strike_price": null,
          "expiration_date": null
        },
        "meta": {
          "source_url": "https://capitoltrades.com/test/e2e-01b",
          "source_id": "e2e_test_01b_pelosi_20260131",
          "scraped_at": "2026-01-31T17:00:00Z"
        }
      }
    },
    {
      "test_id": "test_02_skip_low_score",
      "description": "BUY signal with low score - ChatGPT/Claude SKIP on score, Gemini SKIP on politician filter",
      "expected": {
        "chatgpt": {
          "action": "skip",
          "reason": "Score below 0.55 threshold (stale, large price move, small position)"
        },
        "claude": { "action": "skip", "reason": "Score below 0.55 threshold" },
        "gemini": { "action": "skip", "reason": "Politician not in Titan whitelist" }
      },
      "signal": {
        "source": "house_stock_watcher",
        "politician": {
          "name": "John Smith",
          "chamber": "house",
          "party": "R",
          "state": "TX"
        },
        "trade": {
          "ticker": "XYZ",
          "action": "buy",
          "asset_type": "stock",
          "trade_date": "2026-01-01",
          "trade_price": 50.0,
          "disclosure_date": "2026-01-20",
          "disclosure_price": 62.5,
          "current_price": 65.0,
          "current_price_at": "2026-01-26T16:00:00Z",
          "position_size": "$1,001-$15,000",
          "position_size_min": 1001,
          "position_size_max": 15000,
          "option_type": null,
          "strike_price": null,
          "expiration_date": null
        },
        "meta": {
          "source_url": "https://housestockwatcher.com/test/e2e-02",
          "source_id": "e2e_test_02_skip_score_20260126",
          "scraped_at": "2026-01-26T17:01:00Z"
        }
      }
    },
    {
      "test_id": "test_03_skip_too_old",
      "description": "BUY signal that is too old - all agents SKIP on max_signal_age filter",
      "expected": {
        "chatgpt": { "action": "skip", "reason": "filter_max_age (signal > 45 days old)" },
        "claude": { "action": "skip", "reason": "filter_max_age (signal > 45 days old)" },
        "gemini": { "action": "skip", "reason": "filter_max_age (signal > 45 days old)" }
      },
      "signal": {
        "source": "capitol_trades",
        "politician": {
          "name": "Nancy Pelosi",
          "chamber": "house",
          "party": "D",
          "state": "CA"
        },
        "trade": {
          "ticker": "AAPL",
          "action": "buy",
          "asset_type": "stock",
          "trade_date": "2025-11-01",
          "trade_price": 180.0,
          "disclosure_date": "2025-11-15",
          "disclosure_price": 185.0,
          "current_price": 225.0,
          "current_price_at": "2026-01-26T16:00:00Z",
          "position_size": "$100,001-$250,000",
          "position_size_min": 100001,
          "position_size_max": 250000,
          "option_type": null,
          "strike_price": null,
          "expiration_date": null
        },
        "meta": {
          "source_url": "https://capitoltrades.com/test/e2e-03",
          "source_id": "e2e_test_03_skip_old_20260126",
          "scraped_at": "2026-01-26T17:02:00Z"
        }
      }
    },
    {
      "test_id": "test_04_filter_politician",
      "description": "BUY signal from non-Titan politician - Gemini SKIP on politician filter, others may execute",
      "expected": {
        "chatgpt": { "action": "execute", "reason": "Accepts all politicians, score should pass" },
        "claude": { "action": "execute", "reason": "Accepts all politicians, score should pass" },
        "gemini": { "action": "skip", "reason": "filter_politician (not in Titan whitelist)" }
      },
      "signal": {
        "source": "capitol_trades",
        "politician": {
          "name": "Josh Gottheimer",
          "chamber": "house",
          "party": "D",
          "state": "NJ"
        },
        "trade": {
          "ticker": "MSFT",
          "action": "buy",
          "asset_type": "stock",
          "trade_date": "2026-01-23",
          "trade_price": 420.0,
          "disclosure_date": "2026-01-25",
          "disclosure_price": 422.0,
          "current_price": 425.0,
          "current_price_at": "2026-01-26T16:00:00Z",
          "position_size": "$50,001-$100,000",
          "position_size_min": 50001,
          "position_size_max": 100000,
          "option_type": null,
          "strike_price": null,
          "expiration_date": null
        },
        "meta": {
          "source_url": "https://capitoltrades.com/test/e2e-04",
          "source_id": "e2e_test_04_filter_pol_20260126",
          "scraped_at": "2026-01-26T17:03:00Z"
        }
      }
    },
    {
      "test_id": "test_05_filter_asset_type",
      "description": "OPTION signal - Gemini SKIP on asset type filter (only accepts stock)",
      "expected": {
        "chatgpt": { "action": "execute_or_skip", "reason": "Accepts options, depends on score" },
        "claude": { "action": "execute_or_skip", "reason": "Accepts options, depends on score" },
        "gemini": { "action": "skip", "reason": "filter_asset_type (only accepts stock)" }
      },
      "signal": {
        "source": "unusual_whales",
        "politician": {
          "name": "Nancy Pelosi",
          "chamber": "house",
          "party": "D",
          "state": "CA"
        },
        "trade": {
          "ticker": "GOOGL",
          "action": "buy",
          "asset_type": "option",
          "trade_date": "2026-01-24",
          "trade_price": 15.5,
          "disclosure_date": "2026-01-25",
          "disclosure_price": 16.0,
          "current_price": 16.5,
          "current_price_at": "2026-01-26T16:00:00Z",
          "position_size": "$100,001-$250,000",
          "position_size_min": 100001,
          "position_size_max": 250000,
          "option_type": "call",
          "strike_price": 175.0,
          "expiration_date": "2026-06-20"
        },
        "meta": {
          "source_url": "https://unusualwhales.com/test/e2e-05",
          "source_id": "e2e_test_05_filter_asset_20260126",
          "scraped_at": "2026-01-26T17:04:00Z"
        }
      }
    },
    {
      "test_id": "test_06_price_move_too_large",
      "description": "BUY signal with price moved too much - SKIP on max_price_move filter",
      "expected": {
        "chatgpt": { "action": "skip", "reason": "filter_max_price_move (>25% move)" },
        "claude": { "action": "skip", "reason": "filter_max_price_move (>30% move)" },
        "gemini": { "action": "skip", "reason": "filter_max_price_move (>15% move for Gemini)" }
      },
      "signal": {
        "source": "capitol_trades",
        "politician": {
          "name": "Mark Green",
          "chamber": "house",
          "party": "R",
          "state": "TN"
        },
        "trade": {
          "ticker": "SMCI",
          "action": "buy",
          "asset_type": "stock",
          "trade_date": "2026-01-15",
          "trade_price": 40.0,
          "disclosure_date": "2026-01-20",
          "disclosure_price": 55.0,
          "current_price": 60.0,
          "current_price_at": "2026-01-26T16:00:00Z",
          "position_size": "$250,001-$500,000",
          "position_size_min": 250001,
          "position_size_max": 500000,
          "option_type": null,
          "strike_price": null,
          "expiration_date": null
        },
        "meta": {
          "source_url": "https://capitoltrades.com/test/e2e-06",
          "source_id": "e2e_test_06_price_move_20260126",
          "scraped_at": "2026-01-26T17:05:00Z"
        }
      }
    }
  ]
}
```

---

## Test Execution Instructions for hadoku-site

### Step 1: Initialize Budget (if needed)

```bash
# Check current budget status
curl -X GET "https://hadoku-site.wolffm.workers.dev/api/trader/agents"

# If no budget for current month, insert manually via D1 or let the system auto-create
```

### Step 2: Send Test Signals Sequentially

Send each signal one at a time and verify the response:

```bash
# Signal 1: BUY that passes all filters (expect 3 execute decisions)
curl -X POST "https://hadoku-site.wolffm.workers.dev/api/trader/signals" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_SCRAPER_API_KEY" \
  -d '{
    "source": "capitol_trades",
    "politician": {"name": "Nancy Pelosi", "chamber": "house", "party": "D", "state": "CA"},
    "trade": {
      "ticker": "NVDA",
      "action": "buy",
      "asset_type": "stock",
      "trade_date": "2026-01-24",
      "trade_price": 140.00,
      "disclosure_date": "2026-01-25",
      "disclosure_price": 142.00,
      "current_price": 143.50,
      "current_price_at": "2026-01-26T16:00:00Z",
      "position_size": "$250,001-$500,000",
      "position_size_min": 250001,
      "position_size_max": 500000,
      "option_type": null,
      "strike_price": null,
      "expiration_date": null
    },
    "meta": {
      "source_url": "https://capitoltrades.com/test/e2e-01",
      "source_id": "e2e_test_01_buy_passes_20260126",
      "scraped_at": "2026-01-26T17:00:00Z"
    }
  }'
```

### Step 3: Verify Results

After each signal, check:

```bash
# Check trades table for decisions
curl -X GET "https://hadoku-site.wolffm.workers.dev/api/trader/trades?limit=10"

# Check agent status
curl -X GET "https://hadoku-site.wolffm.workers.dev/api/trader/agents"

# Check positions (for executed signals)
curl -X GET "https://hadoku-site.wolffm.workers.dev/api/trader/agents/chatgpt"
```

### Step 4: Check Cloudflare Worker Logs

In Cloudflare Dashboard, check worker logs for detailed output:

```
[ROUTER] Processing signal: sig_xxxxx
[ROUTER]   Ticker: NVDA, Action: buy
[ROUTER]   Politician: Nancy Pelosi
...
[ROUTER] --- Agent: chatgpt (Decay Edge) ---
[ROUTER]   Decision: execute
[ROUTER]   Score: 0.756
...
[EXECUTION] Calling Fidelity API via tunnel...
[FIDELITY_API] Request payload: { ticker: NVDA, action: buy, quantity: 1.23, dry_run: true }
[FIDELITY_API] *** DRY RUN - Trade was PREVIEWED but NOT executed ***
```

### Step 5: Check Local trader-worker Logs

On your local machine:

```bash
pm2 logs trader-worker
```

Expected output for DRY RUN:

```
Received trade request: BUY 1.23 shares of NVDA
Trade previewed successfully (DRY RUN - no order submitted)
```

---

## Expected Results Summary

**IMPORTANT**: ChatGPT now uses a dynamic Top 10 politician filter. Only signals from Top 10 politicians (by annualized return, min 15 trades, 24-month window) will be processed.

| Test | Signal                      | ChatGPT           | Claude       | Gemini            | Notes                               |
| ---- | --------------------------- | ----------------- | ------------ | ----------------- | ----------------------------------- |
| 1    | Nancy Pelosi NVDA buy       | SKIP (politician) | EXECUTE      | EXECUTE           | Pelosi NOT in current Top 10        |
| 2    | John Smith XYZ buy          | SKIP (politician) | SKIP (score) | SKIP (politician) | Not in Top 10, low score, not Titan |
| 3    | Nancy Pelosi AAPL buy (old) | SKIP (politician) | SKIP (age)   | SKIP (age)        | Not in Top 10, signal > 45 days     |
| 4    | Josh Gottheimer MSFT buy    | SKIP (politician) | EXECUTE      | SKIP (politician) | Not in Top 10 or Titan list         |
| 5    | Nancy Pelosi GOOGL option   | SKIP (politician) | EXECUTE/SKIP | SKIP (asset)      | Not in Top 10, Gemini stock only    |
| 6    | Mark Green SMCI buy         | SKIP (politician) | SKIP (price) | SKIP (price)      | Not in Top 10, price moved > limit  |

### Current Top 10 Filter Behavior

Politicians currently in the computed Top 10 (may vary by data source):

- Rob Bresnahan, Bill Keating, Kathy Manning, David Taylor, Cleo Fields
- Shelley Moore Capito, John Fetterman, James Comer, Marjorie Taylor Greene, Ashley Moody

**Notable exclusions**: Nancy Pelosi, Tommy Tuberville, Tim Moore are NOT in the current Top 10 based on 24-month returns.

---

## Safety Verification

Before any production testing, verify these safeguards:

```bash
# 1. Check DRY_RUN is true in deployed worker
# Look in Cloudflare worker logs for:
# [EXECUTION]   DRY_RUN: true

# 2. Check trader-worker service is in dry mode
curl -X POST "http://localhost:8765/execute-trade" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"ticker": "TEST", "action": "buy", "quantity": 1, "dry_run": true}'

# 3. Response should indicate "Trade previewed successfully"
```

---

## Rollback Procedure

If you need to clean up test data:

```sql
-- Delete test signals
DELETE FROM signals WHERE source_id LIKE 'e2e_test_%';

-- Delete test trades
DELETE FROM trades WHERE signal_id IN (
  SELECT id FROM signals WHERE source_id LIKE 'e2e_test_%'
);

-- Delete test positions
DELETE FROM positions WHERE signal_id IN (
  SELECT id FROM signals WHERE source_id LIKE 'e2e_test_%'
);

-- Reset budgets if needed
UPDATE agent_budgets SET spent = 0 WHERE month = '2026-01';
```
