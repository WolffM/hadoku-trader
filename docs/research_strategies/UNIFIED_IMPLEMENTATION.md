# Unified Multi-Agent Trading Implementation Specification

## Overview

Three independent research agents, each with $1,000/month budget, running simultaneously with separate portfolios and tracking.

| Agent | Codename | Core Philosophy |
|-------|----------|-----------------|
| ChatGPT | **Decay Edge** | Weighted composite scoring, selective execution (10-30% of signals) |
| Claude | **Decay Alpha** | Similar scoring but more detailed formulas, includes stop-loss/take-profit automation |
| Gemini | **Titan Conviction** | Whitelist-only (5 politicians), simpler filters, equal allocation |

---

## Data Requirements (All Agents)

### Signal Input Schema

```typescript
interface Signal {
  signal_id: string;
  ticker: string;
  action: 'buy' | 'sell';
  asset_type: 'stock' | 'etf' | 'option';

  // Pricing
  disclosed_price: number;        // Politician's cost basis
  current_price: number;          // Live quote (required at decision time)

  // Dates
  trade_date: string;             // When politician actually traded
  filing_date: string;            // When disclosure was filed (public)

  // Size
  position_size_min: number;      // Dollar amount (lower bound)
  position_size_max?: number;     // Dollar amount (upper bound, if available)

  // Attribution
  politician_name: string;
  politician_party?: 'D' | 'R';
  source: string;                 // e.g., "quiver_quant", "capitol_trades"

  // Optional enrichment
  sector?: string;
  volatility_daily_std?: number;  // Daily price volatility (for ChatGPT)
}
```

### Required External Data

| Data Point | Used By | Source | Priority |
|------------|---------|--------|----------|
| Real-time stock quotes | ALL | Yahoo Finance / Alpha Vantage | **BLOCKING** |
| Historical politician win rates | ChatGPT, Claude | Computed from trade history | HIGH |
| Source accuracy rates | ChatGPT, Claude | Computed from past signals | MEDIUM |
| Daily volatility (30-day STD) | ChatGPT | Yahoo Finance | MEDIUM |
| Sector classification | Claude | Manual mapping or API | LOW |

---

## Agent 1: ChatGPT ("Decay Edge")

### Hard Filters (Immediate SKIP)

| Condition | Rule |
|-----------|------|
| Trade age | > 45 days → SKIP |
| Buy signal price change | > +25% since politician entry → SKIP |
| Sell signal price change | > -25% since politician entry → SKIP |
| Volatility-adjusted move | > 1.5σ → near-zero score |

### Scoring Components

```
FINAL_SCORE = (freshness × 0.30) + (price_score × 0.25) + (size_score × 0.15)
              + (skill_score × 0.20) + (source_score × 0.10)
```

#### 1. Freshness Score (30%)

```
days_since_trade = today - trade_date
half_life = (volatility >= 2.5% daily STD) ? 7 : 14

freshness = 0.5 ^ (days_since_trade / half_life)
```

#### 2. Price Movement Score (25%)

```
price_change = (current_price - disclosed_price) / disclosed_price
volatility_moves = price_change / (volatility × sqrt(days_since_trade))

IF volatility_moves <= 0.5: price_score = 1.0
ELSE IF volatility_moves <= 1.0: price_score = 0.75
ELSE IF volatility_moves <= 1.5: price_score = 0.4
ELSE: price_score = 0.1
```

#### Volatility Fallback (when data unavailable)

Priority order:
1. **Ticker 30-day daily STD** (preferred)
2. **Sector median volatility**
3. **Market default = 1.5% daily**

Volatility tiers:
| Tier | Daily STD |
|------|-----------|
| Low | < 1.5% |
| Medium | 1.5% - 2.5% |
| High | > 2.5% |

**Conservative bias:** If fallback volatility is used, treat ticker as **one tier riskier** (Medium → High, Low → Medium)

#### 3. Position Size Score (15%)

| Disclosed Size | Score |
|----------------|-------|
| < $15k | 0.2 |
| $15k - $50k | 0.4 |
| $50k - $100k | 0.6 |
| $100k - $250k | 0.8 |
| > $250k | 1.0 |

Asset type modifier:
- Stock: × 1.0
- ETF: × 0.8
- Option: × 1.2

#### 4. Politician Skill Score (20%)

```
IF trade_count < 20: skill_score = 0.5 (neutral)
ELSE:
  skill_score = CLAMP(win_rate, 0.4, 0.7)  // Normalize around 52% baseline
```

#### Win Definition (for politician skill calculation)

A trade is **winning** if:

| Action | Condition | Timeframe |
|--------|-----------|-----------|
| BUY | Price ≥ disclosed_price × 1.05 | Within 90 days of **filing_date** |
| SELL | Price ≤ disclosed_price × 0.95 | Within 90 days of **filing_date** |

- Uses **filing_date** (not trade_date) - fair to our execution timing
- Uses **close price**
- 5% threshold to beat noise & transaction costs
- 90 days matches medium-term congressional horizon

Optional partial credit: +0.5 credit if move hits ±3%, -0.5 penalty if opposite move hits ±5%

#### 5. Source Quality Score (10%)

| Source | Base Score |
|--------|------------|
| Quiver Quant | 1.0 |
| Capitol Trades | 0.9 |
| Unusual Whales | 0.85 |
| Other | 0.8 |

Confirmation bonus: +0.05 per additional source (max +0.15)

### Decision Thresholds

| Final Score | Action |
|-------------|--------|
| ≥ 0.70 | **EXECUTE** (full position) |
| 0.55 - 0.69 | **REBALANCE** (50% of normal position size) |
| < 0.55 | **SKIP** |

**REBALANCE defined:** Execute a **reduced-size position** at 50% of normal EXECUTE size. This is "soft conviction entry" — signal is directionally good but missing one major strength (e.g., late, small size, weaker politician). NOT a portfolio rebalance or trimming existing positions.

### Position Sizing

```
allocation_pct = (final_score)² × 20%
position_size = monthly_budget × allocation_pct

// Constraints
MAX_SINGLE_TRADE = 20% ($200)
MAX_CONCURRENT_POSITIONS = 5
```

### Exit Strategy (Three Independent Rules)

Exit when **first rule triggers**:

#### Exit Rule 1: Time Expiry (Primary)

| Asset Type | Max Hold |
|------------|----------|
| Stock | 120 days |
| ETF | 90 days |
| Option | 30 days OR 7 days before expiration (whichever first) |

#### Exit Rule 2: Signal Invalidation (Weekly Re-evaluation)

Exit if **any** of:
- Composite score drops below **0.45**
- Price exceeds **+30%** (for buy) or **-30%** (for sell)
- **Contradictory congressional trade** appears from same politician OR higher-skill politician

#### Exit Rule 3: Volatility Shock Stop

```
Exit if price moves ≥ 2.5σ against position within 5 trading days
```

This adaptive stop-loss:
- Adjusts to ticker behavior
- Avoids random wick-outs
- Protects against thesis break, not noise

### ChatGPT Summary Table

| Rule | Value |
|------|-------|
| Missing volatility | Sector → default 1.5%, treat as riskier |
| Winning trade | ±5% within 90 days of filing |
| REBALANCE | 50% of normal execute size |
| Max hold | 120d stock / 90d ETF / 30d option |
| Stop-loss | 2.5σ adverse move in 5 days |
| Hard skip | >45 days old or >25% pre-move |

---

## Agent 2: Claude ("Decay Alpha")

### Hard Filters (Immediate SKIP)

| Condition | Rule |
|-----------|------|
| Time decay score | < 0.10 → SKIP |
| Price movement score | < 0.20 → SKIP |
| Price change (implied) | > 30% either direction → SKIP |

### Scoring Components

```
RAW_SCORE = (time_score × 0.30) + (price_score × 0.35) + (conviction × 0.35)
FINAL_SCORE = RAW_SCORE × source_multiplier
```

#### 1. Time Decay Score (30%)

```
days_since_trade = today - trade_date
days_since_filing = today - filing_date

trade_decay = 0.5 ^ (days_since_trade / 14)
filing_decay = 0.5 ^ (days_since_filing / 3)

time_score = MIN(trade_decay, filing_decay)
```

#### 2. Price Movement Score (35%)

```
price_change = (current_price - disclosed_price) / disclosed_price

IF action == 'buy':
  IF price_change <= 0:
    price_score = 1.0 + MIN(0.2, ABS(price_change))  // Bonus for dip
  ELSE IF price_change <= 0.05:
    price_score = 1.0 - (price_change × 4)           // 1.0 → 0.8
  ELSE IF price_change <= 0.15:
    price_score = 0.8 - ((price_change - 0.05) × 4)  // 0.8 → 0.4
  ELSE:
    price_score = MAX(0, 0.4 - ((price_change - 0.15) × 2))

IF action == 'sell':
  // Inverse: favorable when price went UP since their sale
  (mirror the above with flipped signs)
```

#### 3. Conviction Score (35%)

```
conviction = 0.50  // baseline

// Position size bonus
IF position_size_min >= 500000: conviction += 0.25
ELSE IF position_size_min >= 250000: conviction += 0.20
ELSE IF position_size_min >= 100000: conviction += 0.15
ELSE IF position_size_min >= 50000: conviction += 0.10
ELSE: conviction += 0.05

// Politician track record
IF politician_win_rate exists:
  conviction += (politician_win_rate - 0.5) × 0.4

// Cross-confirmation (same ticker+action within 7 days)
conviction += MIN(0.15, (confirmation_count - 1) × 0.05)

// Filing speed bonus/penalty
filing_delay = filing_date - trade_date
IF filing_delay <= 7: conviction += 0.05
IF filing_delay >= 30: conviction -= 0.10

// Asset type
IF asset_type == 'option': conviction += 0.10

conviction = CLAMP(conviction, 0, 1)
```

#### 4. Source Multiplier

```
IF source_accuracy exists:
  source_multiplier = 0.8 + ((source_accuracy - 0.5) × 2)
ELSE:
  source_multiplier = 1.0

source_multiplier = CLAMP(source_multiplier, 0.8, 1.2)
```

### Decision Thresholds

| Final Score | Decision | Interpretation |
|-------------|----------|----------------|
| < 0.55 | **SKIP** | |
| 0.55 - 0.70 | **EXECUTE** | Standard conviction |
| 0.70 - 0.85 | **EXECUTE** | High conviction |
| > 0.85 | **EXECUTE** | Max conviction |

### Position Sizing

```
position_size = base_amount × final_score
where base_amount = $200

// Result: $110 - $200 per trade

// Constraints
MAX_SINGLE_TRADE = $250 (25%)
MIN_TRADE = $50
MAX_OPEN_POSITIONS = 10
RESERVE = $100 liquid if < 5 positions open
```

### Risk Management (AUTOMATED)

#### Stop Loss

| Condition | Action |
|-----------|--------|
| Position down 15% from entry | Sell immediately |
| Position down 10% AND held > 14 days | Sell |

#### Take Profit

| Condition | Action |
|-----------|--------|
| Position up 25% | Sell 50% of position |
| Position up 40% | Sell remaining |

#### Time-Based Exit (Staged Evaluation)

Original scoring algorithm doesn't work here (time decay would auto-fail at 60 days). Use staged evaluation instead:

**At 60 days:**

| Position Status | Action |
|-----------------|--------|
| Profitable (any amount) | Continue holding, check again at 90 days |
| Down 0% to -5% | Hold, set 5% trailing stop |
| Down >5% | Close position |

**At 90 days:**

| Position Status | Action |
|-----------------|--------|
| Up >10% | Hold with 10% trailing stop |
| Up 0-10% | Close position |
| Negative | Close position |

**At 120 days:** Close regardless of performance.

**Intent:** Don't let positions drift indefinitely, but give winners room to run while cutting losers that haven't recovered.

#### Concentration Limits

- Max 30% of portfolio in single sector
- Max 2 positions in same ticker

#### Sector Classification

**Source:** Yahoo Finance via `yfinance` Python library

```python
import yfinance
sector = yfinance.Ticker("MSFT").info["sector"]
# Returns: "Technology", "Healthcare", "Financial Services", etc.
```

**Fallback:** If Yahoo fails or ticker not found → classify as "Unknown" and **exclude from sector concentration checks** (still allow the trade)

### Claude Summary Table

| Rule | Value |
|------|-------|
| Time decay half-life | 14 days (trade) / 3 days (filing) |
| Price score weight | 35% (highest) |
| Hard filters | Time score <0.10, price score <0.20 |
| Execute threshold | ≥ 0.55 |
| Position sizing | $200 × score = $110-$200 |
| Stop-loss | 15% down (immediate) or 10% down after 14 days |
| Take-profit | 25% up → sell 50%; 40% up → sell rest |
| Time-based exit | Staged at 60/90/120 days |
| Max concentration | 30% per sector, 2 positions per ticker |
| Sector source | Yahoo Finance (`yfinance`) |
| Sell handling | If not held → SKIP (no shorting) |

---

## Agent 3: Gemini ("Titan Conviction")

### Fundamental Difference

**Gemini ONLY tracks 5 specific politicians.** All other signals are ignored.

### The Watchlist (The "Titans")

| Politician | Party | Role |
|------------|-------|------|
| Nancy Pelosi | D-CA | Primary Growth Signal |
| Mark Green | R-TN | Primary Value Hedge |
| Michael McCaul | R-TX | Secondary Growth |
| Ro Khanna | D-CA | Volume Confirmation |
| Rick Larsen | D-WA | Strategic Diversifier |

#### Succession Protocol (When a Titan Leaves Office)

**Trigger:** Retirement, resignation, election loss, or death.

**Replacement Algorithm:**
1. Run candidate screening on remaining Congress members
2. **Screening Criteria:**
   - Volume: > $5M traded in last 12 months
   - Performance: Sharpe Ratio > SPY over last 3 years
   - **Sector Match:** Replace "like with like" to maintain balance
     - Democrat/Tech heavy hitter → replace with next highest volume Democrat
     - Republican/Energy heavy hitter → replace with next highest volume Republican
3. **Source:** Quiver Quant or Capitol Trades "Top Traders" leaderboards

### Hard Filters

| Condition | Rule |
|-----------|------|
| Politician not in watchlist | SKIP |
| Asset type != stock | SKIP (no options, bonds) |
| Price change > +15% since entry | SKIP ("overheated") |

### Signal Processing

```
1. Query disclosures for Titans only (last 45 days)
2. IF asset_type != 'stock': DISCARD
3. IF action == 'sell':
   - Check portfolio holdings
   - IF we_hold_position: SELL 100% immediately
   - IF NOT held: IGNORE (log as "Ignored - Not Held")
   - **STRICTLY NO SHORTING** (long-only strategy)
4. IF action == 'buy':
   - Calculate delta = (current_price - entry_price) / entry_price
   - IF delta > 0.15: REJECT (overheated)
   - ELSE: ADD to buy list
```

**Why no shorting?** Shorting requires margin, involves infinite risk, and is dangerous with delayed data (price drop often happens *before* disclosure).

### Capital Allocation (Simple Equal-Weight)

```
allocation_per_signal = monthly_budget / count(accepted_signals)

// Example: 4 valid signals → $250 each
```

### Dry Spell Fallback ("Consensus Core")

**If no signals pass filters for the month:** Allocate 100% to the Consensus Core basket.

**Current Consensus Core (as of Jan 2026):**

| Ticker | Allocation | Rationale |
|--------|------------|-----------|
| NVDA | 30% ($300) | Tech Consensus |
| MSFT | 30% ($300) | Tech Consensus |
| ET | 20% ($200) | Energy Consensus |
| AAPL | 20% ($200) | Safety Consensus |

#### Dynamic Basket Updates

**Update Frequency:** Semi-annually (Jan 1st and June 1st)

**"Consensus Core" Algorithm:**
1. Scan current portfolios of all 5 Titans
2. Identify top 4 tickers that appear in the **most** Titan portfolios
3. **Tie-breaker:** If multiple stocks have same overlap, select one with highest **total dollar volume** bought by Titans in last 6 months
4. Update allocation targets to these 4 tickers

**Why dynamic?** Fixed baskets are dangerous if market regime shifts (AI bubble burst, energy crash, etc.)

### Risk Management

#### Trailing Stop Loss

- **20% trailing stop** on ALL positions
- Trigger: If price drops 20% from highest point since purchase → SELL MARKET

#### Concentration Limit

- Max 30% of total portfolio in any single ticker
- If exceeded: redirect new funds to underweight positions

### Maintenance Protocols

- **Quarterly:** Verify Titans still in office, run Succession Protocol if needed
- **Semi-annually:** Review and update Consensus Core basket (Jan 1, June 1)
- **Kill Switch:** If Congress bans trading → liquidate all → convert to QQQ

### Gemini Summary Table

| Rule | Value |
|------|-------|
| Politicians tracked | 5 Titans only (whitelist) |
| Asset types | Stocks only (no options/bonds) |
| Overheated filter | >15% price move since entry → SKIP |
| Allocation | Equal-weight among accepted signals |
| Dry spell fallback | Consensus Core basket (dynamic, semi-annual) |
| Stop-loss | 20% trailing stop on ALL positions |
| Max concentration | 30% per ticker |
| Sell handling | If held → sell 100%; if not held → IGNORE (no shorting) |
| Titan succession | Replace like-with-like based on volume + Sharpe |

---

## Implementation Requirements Summary

### Database Schema Additions

```sql
-- Agent configuration
CREATE TABLE agents (
  id TEXT PRIMARY KEY,          -- 'chatgpt', 'claude', 'gemini'
  codename TEXT,
  monthly_budget REAL DEFAULT 1000,
  strategy_version TEXT,
  is_active BOOLEAN DEFAULT true
);

-- Agent portfolios (separate from main)
CREATE TABLE agent_positions (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  ticker TEXT,
  shares REAL,
  entry_price REAL,
  entry_date TEXT,
  highest_price REAL,           -- For trailing stop (Gemini)
  cost_basis REAL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Agent trade history
CREATE TABLE agent_trades (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  signal_id TEXT,
  ticker TEXT,
  action TEXT,                  -- 'buy', 'sell', 'skip'
  decision_reason TEXT,
  scores JSON,                  -- Full scoring breakdown
  position_size REAL,
  executed_price REAL,
  executed_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Politician performance tracking
CREATE TABLE politician_stats (
  politician_name TEXT PRIMARY KEY,
  total_trades INTEGER,
  winning_trades INTEGER,
  win_rate REAL,
  avg_return REAL,
  last_updated TEXT
);

-- Source accuracy tracking
CREATE TABLE source_stats (
  source_name TEXT PRIMARY KEY,
  total_signals INTEGER,
  accurate_signals INTEGER,
  accuracy_rate REAL,
  last_updated TEXT
);
```

### API Endpoints Needed

| Endpoint | Purpose |
|----------|---------|
| `GET /agents` | List all agents with status |
| `GET /agents/:id/portfolio` | Agent's current positions |
| `GET /agents/:id/trades` | Agent's trade history |
| `GET /agents/:id/performance` | Returns, win rate, vs benchmark |
| `POST /agents/:id/process-signal` | Run scoring algorithm |
| `POST /agents/:id/execute` | Execute a trade decision |
| `GET /signals/pending` | Signals awaiting processing |
| `GET /quotes/:ticker` | Real-time price |

### Scheduled Jobs

| Job | Frequency | Description |
|-----|-----------|-------------|
| Process new signals | Every 6 hours | Run all 3 agents against new signals |
| Check stop-loss/take-profit | Every 15 min (market hours) | Claude only (15% hard stop, staged trailing) |
| Check trailing stops | Every 15 min (market hours) | Gemini only (20% trailing) |
| Check volatility shock stops | Every 15 min (market hours) | ChatGPT only (2.5σ in 5 days) |
| Weekly position re-evaluation | Weekly | ChatGPT: re-score positions, exit if <0.45 |
| Daily staged exit check | Daily | Claude: check 60/90/120 day positions, apply staged rules |
| Update politician stats | Daily | Recalculate win rates |
| Monthly budget reset | 1st of month | Reset available budget |
| Quarterly Titan check | Quarterly | Gemini: verify Titans still in office, run succession if needed |
| Semi-annual basket review | Jan 1 & June 1 | Gemini: update Consensus Core basket from Titan holdings |

---

## Questions Requiring Clarification

### For ChatGPT

✅ All questions answered - see inline documentation above.

### For Claude

✅ All questions answered - see inline documentation above.

### For Gemini

✅ All questions answered - see inline documentation above.

**Remaining infrastructure question (for you, not Gemini):**
- **Fractional shares:** Does Fidelity support fractional shares for all tickers? Need to verify API capability.

---

## Dashboard Enhancements

### New Views Needed

1. **Agent Comparison Dashboard**
   - Side-by-side performance (ChatGPT vs Claude vs Gemini vs SPY)
   - Monthly returns chart
   - Win rate comparison

2. **Per-Agent Detail View**
   - Current portfolio
   - Recent decisions with full scoring breakdown
   - Budget utilization

3. **Signal Processing Log**
   - Show how each agent scored the same signal
   - Highlight divergent decisions

4. **Leaderboard**
   - Which agent is winning?
   - Historical performance by month

---

## Implementation Priority

### Phase 1: Core Scoring Engine
- [ ] Implement all 3 scoring algorithms
- [ ] Signal processing pipeline
- [ ] Decision logging

### Phase 2: Execution
- [ ] Position sizing per algorithm
- [ ] Trade execution via Fidelity
- [ ] Portfolio tracking per agent

### Phase 3: Risk Management
- [ ] Claude: Stop-loss/take-profit automation
- [ ] Gemini: Trailing stop automation
- [ ] Concentration limit enforcement

### Phase 4: Analytics
- [ ] Politician win rate calculation
- [ ] Source accuracy tracking
- [ ] Performance benchmarking

### Phase 5: Dashboard
- [ ] Agent comparison views
- [ ] Signal decision breakdown
- [ ] Historical performance charts
