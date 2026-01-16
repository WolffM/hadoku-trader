# Hadoku Trading Agent - Implementation Specification

## Overview

**Budget**: $1,000/month  
**Strategy**: Score-based congressional trade copying with decay modeling  
**Agent Name**: Decay Alpha

---

## Capital Allocation

### Monthly Budget Rules

| Rule | Value |
|------|-------|
| Monthly allocation | $1,000 |
| Max per single trade | $250 (25%) |
| Min per trade | $50 |
| Max open positions | 10 |
| Reserve for opportunities | Keep $100 liquid if <5 positions open |

### Position Sizing Formula

```
position_size = base_amount × conviction_score

where:
  base_amount = $200
  conviction_score = final algorithm score (0.55 - 1.0)
  
Result: positions range from $110 to $200
```

---

## Signal Scoring Algorithm

### Input Required Per Signal

```
- ticker: string
- action: 'buy' | 'sell'
- disclosed_price: number (politician's cost basis)
- disclosed_date: ISO date string
- filing_date: ISO date string
- position_size_min: number (dollars)
- politician_name: string
- source: string
- current_price: number (live quote)
```

### Component 1: Time Decay Score (30% weight)

```
days_since_trade = today - disclosed_date
days_since_filing = today - filing_date

trade_decay = 0.5 ^ (days_since_trade / 14)
filing_decay = 0.5 ^ (days_since_filing / 3)

time_score = MIN(trade_decay, filing_decay)

HARD FILTER: if time_score < 0.10 → SKIP
```

### Component 2: Price Movement Score (35% weight)

```
price_change = (current_price - disclosed_price) / disclosed_price

IF action == 'buy':
    IF price_change <= 0:
        price_score = 1.0 + MIN(0.2, ABS(price_change))
    ELSE IF price_change <= 0.05:
        price_score = 1.0 - (price_change × 4)
    ELSE IF price_change <= 0.15:
        price_score = 0.8 - ((price_change - 0.05) × 4)
    ELSE:
        price_score = MAX(0, 0.4 - ((price_change - 0.15) × 2))

IF action == 'sell':
    (inverse logic - favorable when price went UP)

HARD FILTER: if price_score < 0.20 → SKIP
```

### Component 3: Conviction Score (35% weight)

```
conviction = 0.50 (baseline)

// Position size bonus
IF position_size_min >= 500000: conviction += 0.25
ELSE IF position_size_min >= 250000: conviction += 0.20
ELSE IF position_size_min >= 100000: conviction += 0.15
ELSE IF position_size_min >= 50000: conviction += 0.10
ELSE: conviction += 0.05

// Politician track record (if available)
IF politician_win_rate exists:
    conviction += (politician_win_rate - 0.5) × 0.4

// Cross-confirmation
confirmation_count = number of sources reporting same ticker+action within 7 days
conviction += MIN(0.15, (confirmation_count - 1) × 0.05)

// Filing speed
filing_delay = filing_date - disclosed_date
IF filing_delay <= 7: conviction += 0.05
IF filing_delay >= 30: conviction -= 0.10

// Asset type
IF asset_type == 'option': conviction += 0.10

conviction = CLAMP(conviction, 0, 1)
```

### Component 4: Source Multiplier

```
IF source historical accuracy available:
    source_multiplier = 0.8 + ((source_accuracy - 0.5) × 2)
ELSE:
    source_multiplier = 1.0

source_multiplier = CLAMP(source_multiplier, 0.8, 1.2)
```

### Final Score Calculation

```
raw_score = (time_score × 0.30) + (price_score × 0.35) + (conviction × 0.35)
final_score = raw_score × source_multiplier
final_score = CLAMP(final_score, 0, 1)
```

### Decision Thresholds

| Score Range | Decision |
|-------------|----------|
| < 0.55 | SKIP |
| 0.55 - 0.70 | EXECUTE (standard) |
| 0.70 - 0.85 | EXECUTE (high conviction) |
| > 0.85 | EXECUTE (max conviction) |

---

## Execution Rules

### When to Execute

1. Process new signals every **6 hours**
2. Execute trades during **market hours only** (9:30 AM - 4:00 PM ET)
3. If signal arrives after hours, queue for next market open

### Order Type

- Use **market orders** for simplicity
- For positions >$150, consider **limit order** at current price + 0.5% buffer

### Sell Signal Handling

For SELL signals from politicians:
1. If we hold the position → close it
2. If we don't hold it → **do not short** (skip the signal)

---

## Risk Management

### Stop Loss Rules

| Condition | Action |
|-----------|--------|
| Position down 15% from entry | Sell immediately |
| Position down 10% AND held >14 days | Sell |

### Take Profit Rules

| Condition | Action |
|-----------|--------|
| Position up 25% | Sell 50% of position |
| Position up 40% | Sell remaining |

### Time-Based Exit

- If position held >60 days with no stop/profit trigger, re-evaluate
- If current score (re-run algorithm with fresh data) < 0.40, close position

### Concentration Limits

- Max 30% of portfolio in single sector
- Max 2 positions in same ticker (from different politician signals)

---

## Data Requirements

### Must Have (Blocking)

- [ ] Real-time stock quotes (for current_price)
- [ ] Signal data from at least one source
- [ ] Trade execution capability via Fidelity API

### Should Have (Improves Performance)

- [ ] Historical politician win rates
- [ ] Historical source accuracy rates
- [ ] Cross-source signal aggregation

### Nice to Have

- [ ] Sector classification for concentration limits
- [ ] Options data parsing
- [ ] Volatility normalization

---

## Logging Requirements

Every trade decision must log:

```json
{
  "timestamp": "ISO datetime",
  "signal_id": "unique identifier",
  "ticker": "MSFT",
  "action": "buy",
  "decision": "execute",
  "scores": {
    "time_decay": 0.45,
    "price_movement": 0.82,
    "conviction": 0.71,
    "source_multiplier": 1.0,
    "final": 0.67
  },
  "hard_filters_triggered": [],
  "position_size": 134.00,
  "current_price": 402.50,
  "disclosed_price": 395.00,
  "politician": "Nancy Pelosi",
  "days_since_trade": 8,
  "days_since_filing": 2
}
```

---

## Monthly Performance Tracking

Track and report:

- Total trades executed
- Win rate (% of trades that were profitable at exit)
- Average return per trade
- Total portfolio value
- Sharpe ratio (if possible)
- Best/worst performing signals
- Breakdown by: politician, source, sector

---

## Priority Implementation Order

1. **Phase 1**: Basic scoring engine + execute/skip decisions
2. **Phase 2**: Position sizing based on conviction
3. **Phase 3**: Stop loss / take profit automation
4. **Phase 4**: Historical tracking for politician/source accuracy
5. **Phase 5**: Cross-confirmation detection

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Same signal from multiple sources | Count as 1 trade, boost conviction |
| Politician sells stock we don't own | Skip (no shorting) |
| Signal for delisted/halted ticker | Skip |
| Budget exhausted mid-month | Queue high-conviction signals for next month |
| Duplicate signal (same politician, ticker, date) | Deduplicate, process once |
| Price moved >30% since trade | Auto-skip (hard filter) |

---

## Success Metrics

**Target Performance (Monthly)**:
- Execute 3-8 trades
- Win rate >55%
- Average return per trade >3%
- Max drawdown <20% of portfolio

**Evaluation Period**: 3 months minimum before strategy adjustments