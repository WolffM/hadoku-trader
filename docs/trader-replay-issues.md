# Trader Pipeline E2E Replay Issues

**Date**: 2026-01-31
**Test**: 45-day signal replay (274 signals)
**Expected**: 23 executed trades for ChatGPT (per hadoku-trader simulation)
**Actual**: 0 executed trades for ChatGPT

---

## Summary of Issues

### Issue 1: ChatGPT agent not using Top 10 politician filter

**Severity**: Critical

**Expected Behavior**: ChatGPT "Decay Edge" agent should only process signals from Top 10 politicians (per the "chatgptTop10" config in hadoku-trader simulation).

**Actual Behavior**: Agent config has `politician_whitelist: null` - processing ALL politicians.

**Evidence**:

```sql
SELECT json_extract(config_json, '$.politician_whitelist') FROM agents WHERE id = 'chatgpt';
-- Result: null
```

ChatGPT processed signals from politicians like Gil Cisneros, Bernie Moreno, John Boozman, etc. who are not in Top 10.

**Fix Required**: Package needs to either:

1. Dynamically load Top 10 from `politician_rankings` table during processing
2. Set `politician_whitelist` when seeding agent config

---

### Issue 2: All 3 agents active in production instead of just ChatGPT

**Severity**: High

**Expected Behavior**: Only ChatGPT (chatgptTop10) should be active for production trading.

**Actual Behavior**: 3 agents are active: `chatgpt`, `claude`, `gemini`

**Evidence**:

```sql
SELECT id FROM agents WHERE is_active = 1;
-- chatgpt, claude, gemini
```

**Impact**: Resources wasted processing signals for inactive agents, potential conflicts.

**Fix Required**: Production deployment should only activate the production agent.

---

### Issue 3: DRY_RUN = true in package prevents real trades

**Severity**: High (for production deployment)

**Location**: `@wolffm/trader-worker/dist/agents/tradingConfig.d.ts`

**Current Value**: `DRY_RUN = true`

**Impact**: Even when calling execution endpoints, no real trades are placed with Fidelity.

**Fix Required**: Package needs build-time or runtime flag to enable live trading:

- Option A: Environment variable `ENABLE_LIVE_TRADING`
- Option B: Separate production build with `DRY_RUN = false`

---

### Issue 4: Corrupted price data for some signals

**Severity**: Medium

**Example**: Nancy Pelosi GOOGL signal

```
ticker: GOOGL
trade_price: 15.5       <- Clearly wrong (GOOGL is ~$200)
current_price: 330
```

This causes `filter_price_move` to trigger (price change > 25% threshold).

**Other Examples**:

- Nancy Pelosi NVDA: trade_price 140, current_price 186.23 (33% change - above threshold)

**Root Cause**: Unknown - possibly scraper or ingest issue

**Fix Required**: Data validation at ingest time:

- Reject prices < $1 for stocks
- Cross-reference with market data at ingest time

---

### Issue 5: IEP signal (ct_20003794280) expected as first BUY, but skipped

**Expected**: First trade should be IEP at $7.37 (per acceptance criteria)

**Actual**: Skipped with `skip_score` (score: 0.498 < threshold: 0.55)

**Score Breakdown**:

```json
{
  "time_decay": 0.05, // Very low - trade was 43 days ago
  "price_movement": 0.93,
  "position_size": 0.4,
  "politician_skill": 0.5,
  "source_quality": 0.9
}
```

**Issues**:

1. Politician is **Nicole Malliotakis** (not Top 10) - should have been filtered
2. `time_decay` is 0.05 because trade was 43 days old (half_life: 10 days)

**Discrepancy**: hadoku-trader simulation expected this trade to execute. Either:

- Simulation used different time window/thresholds
- Simulation had different politician filter
- Dates calculated differently

---

### Issue 6: Stale market prices (13 days old)

**Newest price date**: 2026-01-18
**Current date**: 2026-01-31

**Impact**: Price calculations use 13-day-old prices, affecting:

- `price_movement` scoring
- Position sizing
- Exit condition checks

**Fix Required**:

- `syncMarketPrices` should fetch current day prices
- Add staleness check before processing

---

### Issue 7: Budget spent for claude/gemini but $0 for chatgpt

**Current State**:

```
chatgpt: $1000 budget, $0 spent
claude:  $1000 budget, $1000 spent (maxed out)
gemini:  $1000 budget, $1000 spent (maxed out)
```

**Observation**: Claude and Gemini hit budget limits, but ChatGPT spent nothing because all signals were skipped.

---

## Database State After Replay

```sql
-- Trades by decision (BUY signals only)
chatgpt: 81 skip_score, 13 skip_size_zero, 5 filter_price_move, 3 filter_asset_type
claude:  43 skip_score, 52 skip_size_zero, 4 filter_price_move, 3 filter_asset_type
gemini:  93 filter_politician, 1 execute, 5 skip_size_zero, 2 filter_price_move, 1 filter_asset_type

-- Open positions
gemini: 1 position (DRI @ $214.62)

-- Executed trades
gemini: 1 (DRI)
chatgpt: 0
claude: 0
```

---

## Recommendations for Package Team

1. **Add Top10 politician filter integration** - Agent should automatically use `politician_rankings` table
2. **Add runtime trading mode flag** - Allow `DRY_RUN` to be controlled via environment
3. **Add data validation** - Reject obviously invalid prices at ingest
4. **Add market price freshness check** - Fail if prices are >1 trading day stale
5. **Document expected behavior** - Clear specs for simulation vs production behavior

---

## Next Steps

1. Fix ChatGPT politician filter (critical)
2. Enable live trading mode
3. Clear test data and re-run with corrected config
4. Compare results against simulation acceptance criteria
