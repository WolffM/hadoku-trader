Perfect, that clarifies a lot. Updated plan:

## Congress Trade Copier - Refined

### Execution Logic

```
On new signal:
  1. Dedupe check - have we seen this trade before?
  2. If duplicate signal → increase position size multiplier
  3. Calculate "priced in" score:
     - days since disclosure
     - price movement since disclosed price
     - volume anomalies
  4. Calculate position size:
     - base: politician's relative trade size
     - multiplied by: signal count (more sources = higher conviction)
     - reduced by: priced-in score
     - capped by: monthly budget remaining
  5. Execute or skip
  6. Log everything
```

### Position Sizing Formula (draft)

```python
def calculate_position_size(signal, monthly_budget_remaining, monthly_cap):
    # Base size from politician's trade
    base_sizes = {
        "$1K-$15K": 0.02,      # 2% of our monthly cap
        "$15K-$50K": 0.05,
        "$50K-$100K": 0.10,
        "$100K-$250K": 0.15,
        "$250K-$500K": 0.20,
        "$500K+": 0.25,
    }
    base = base_sizes.get(signal.position_size, 0.02) * monthly_cap
    
    # Conviction multiplier (more sources reporting = higher)
    conviction = 1 + (0.25 * (signal.source_count - 1))  # +25% per additional source
    
    # Priced-in discount
    price_move = abs(current_price - signal.disclosed_price) / signal.disclosed_price
    days_stale = (today - signal.disclosed_date).days
    
    priced_in_factor = max(0.2, 1 - (price_move * 2) - (days_stale * 0.01))
    
    final = base * conviction * priced_in_factor
    return min(final, monthly_budget_remaining)
```

### Data Flow

```
hadoku-scraper
    │
    │ POST /signals (webhook)
    ▼
┌─────────────────────────────────────┐
│         congress-trader             │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────┐  ┌──────────────┐  │
│  │Signal Queue │→ │ Deduplicator │  │
│  └─────────────┘  └──────┬───────┘  │
│                          │          │
│                          ▼          │
│               ┌──────────────────┐  │
│               │ Position Sizer   │  │
│               │ • base from tier │  │
│               │ • conviction mul │  │
│               │ • priced-in disc │  │
│               └────────┬─────────┘  │
│                        │            │
│                        ▼            │
│               ┌──────────────────┐  │
│               │ Trade Executor   │  │
│               │ (fidelity-api)   │  │
│               └────────┬─────────┘  │
│                        │            │
│         ┌──────────────┼───────────┐│
│         ▼              ▼           ▼│
│  ┌──────────┐  ┌────────────┐  ┌───┴───┐
│  │ Audit DB │  │ Portfolio  │  │ API   │
│  │          │  │ State      │  │ (dash)│
│  └──────────┘  └────────────┘  └───────┘
└─────────────────────────────────────┘
                     │
                     │ REST
                     ▼
            ┌─────────────────┐
            │   hadoku.me     │
            │ /congress-trader│
            └─────────────────┘
```

### API Endpoints

```
# From hadoku-scraper
POST /signals
  { source, politician, ticker, action, disclosed_price, ... }

# For dashboard
GET /portfolio
  → current positions, P&L, allocation

GET /trades
  → history with full reasoning

GET /performance
  → returns vs benchmarks (SPY, NANC, KRUZ, per-source)

GET /budget
  → monthly cap, spent, remaining

GET /signals
  → all received signals + disposition (executed/skipped/pending)
```

### Dashboard Sections (hadoku.me/congress-trader)

1. **Overview** - Total value, MTD/YTD return, vs SPY
2. **Live Portfolio** - Current positions with cost basis and P&L
3. **Trade Log** - Every trade with reasoning chain visible
4. **Source Leaderboard** - Which trackers are generating alpha
5. **Signals Feed** - Incoming signals, executed vs skipped
6. **Monthly Budget** - Visual of cap utilization

### File Structure

```
congress-trader/
├── src/
│   ├── api/
│   │   ├── routes.py        # FastAPI endpoints
│   │   └── schemas.py       # Pydantic models
│   ├── core/
│   │   ├── signals.py       # Signal processing, deduping
│   │   ├── sizing.py        # Position size calculation
│   │   ├── executor.py      # Trade execution wrapper
│   │   └── portfolio.py     # Position tracking, P&L
│   ├── broker/
│   │   └── fidelity/        # Forked fidelity-api
│   ├── db/
│   │   ├── models.py        # SQLAlchemy models
│   │   └── migrations/
│   └── config.py
├── tests/
├── docker-compose.yml
├── .env.example
└── README.md
```

### Next Steps

1. **Fork fidelity-api** - Get it running locally, test with your account (dry run first)
2. **Set up congress-trader repo** - Basic FastAPI skeleton + DB models
3. **Signal ingestion** - Webhook endpoint that hadoku-scraper can POST to
4. **Position sizing** - Implement the formula, make it configurable
5. **Execution** - Wire up fidelity-api fork
6. **Dashboard API** - Endpoints for the frontend
7. **hadoku.me integration** - Build the dashboard UI

Want me to scaffold out the initial repo structure, or start with forking/auditing fidelity-api first?