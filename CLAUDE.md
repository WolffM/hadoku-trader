# Claude Code Instructions for hadoku-trader

## Working Style

**BE PROACTIVE. DO NOT ASK UNNECESSARY QUESTIONS.**

- When asked to make a change, MAKE IT. Don't ask for confirmation.
- When asked to commit, COMMIT AND PUSH. Deployment is automatic.
- When something is obviously needed (like wiring up a route for an exported function), DO IT without being asked.
- If you need to bump versions, bump them.
- If tests need to run, run them.
- If changes need to be committed, commit them with a good message.
- NEVER say "let me know when you're ready" - just do the work.

## Project Context

This is a congressional trade copying system with a multi-agent trading engine. The goal is to:

1. Receive signals from hadoku-scraper about congressional stock trades
2. Score and process signals through 3 independent trading agents (ChatGPT, Claude, Gemini)
3. Display a dashboard showing agent/portfolio performance vs benchmarks
4. Auto-execute trades via Fidelity

## Architecture

```
hadoku-scraper ──► hadoku-site (CF Worker + D1) ──► hadoku-trader (Dashboard)
                         │                                   │
                         │ @wolffm/trader-worker             │
                         │ (multi-agent engine)              │
                         │                                   ▼ trade requests
                         └──► Local PM2 (fidelity-api via cloudflared tunnel)
```

Data flow:

1. hadoku-site fetches data from hadoku-scraper every 8 hours
2. Signals are processed through the multi-agent engine (scoring, sizing, execution decisions)
3. Data stored in D1 (Cloudflare's SQLite)
4. Dashboard fetches data via REST API from hadoku-site
5. Trade execution: dashboard → hadoku-site → cloudflared tunnel → local PM2 → fidelity-api

## File Structure

```
hadoku-trader/
├── src/                      # React frontend (@wolffm/trader)
│   ├── App.tsx               # Main component
│   ├── entry.tsx             # Mount/unmount exports
│   ├── app/                  # App config (themeConfig)
│   ├── components/Dashboard/ # Dashboard components
│   ├── data/                 # Mock data for development
│   ├── hooks/                # Custom React hooks
│   ├── services/             # API service layer
│   ├── styles/               # CSS
│   └── types/                # TypeScript types
├── worker/                   # Cloudflare Worker package (@wolffm/trader-worker)
│   ├── src/
│   │   ├── index.ts          # Package exports
│   │   ├── handler.ts        # Request router
│   │   ├── routes.ts         # Route handlers
│   │   ├── scheduled.ts      # Cron jobs
│   │   ├── types.ts          # TypeScript types
│   │   ├── utils.ts          # Utilities
│   │   └── agents/           # Multi-agent trading engine
│   │       ├── configs.ts    # Agent configurations
│   │       ├── scoring.ts    # Signal scoring (7 components)
│   │       ├── sizing.ts     # Position sizing (3 modes)
│   │       ├── execution.ts  # Trade execution
│   │       ├── monitor.ts    # Position monitoring
│   │       ├── simulation.ts # Backtesting framework
│   │       ├── filters.ts    # Signal filters
│   │       ├── router.ts     # Agent routing
│   │       ├── loader.ts     # Config loader
│   │       ├── metrics.ts    # Performance metrics
│   │       ├── priceProvider.ts # Price data
│   │       └── types.ts      # Agent types
│   ├── migrations/           # D1 migrations
│   ├── schema.sql            # D1 database schema
│   └── package.json          # Publishes to GitHub Packages
├── trader-worker/            # Local trade execution service
│   ├── main.py               # FastAPI service
│   ├── ecosystem.config.js   # PM2 config
│   └── requirements.txt      # Python dependencies
├── fidelity-api/             # Forked broker automation library
│   ├── fidelity/             # Core library
│   └── hadoku_fidelity/      # CLI/service wrapper
├── docs/
│   ├── ENGINE_SPEC.md        # Full multi-agent engine specification
│   ├── SCRAPER_INTEGRATION.md # How to integrate scrapers
│   ├── HADOKU_SITE_INTEGRATION.md # How to integrate with hadoku-site
│   └── SIMULATION_FINDINGS.md # Backtesting results and optimal configuration
└── package.json
```

## Simulation & Analysis Test Files

The following test files in `worker/src/agents/` are **critical analysis tools**, not just unit tests. They run backtests and strategy analysis against historical data. **Do not delete or refactor these files:**

| File                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `simulation.test.ts`            | Portfolio simulation, strategy backtesting, tax analysis |
| `politician-analysis.test.ts`   | Individual politician performance analysis               |
| `scoring-retrospective.test.ts` | Scoring algorithm validation against actual returns      |
| `strategy-variations.test.ts`   | A/B testing different strategy parameters                |

These files use `trader-db-export.json` (261MB, gitignored) which contains historical signal data. Shared utilities are in `test-utils.ts`.

Run analysis: `cd worker && pnpm test <filename>`

## Multi-Agent Trading Engine

Three agents run independently with $1,000/month budget each:

| Agent                       | Strategy                  | Signals                               | Sizing       |
| --------------------------- | ------------------------- | ------------------------------------- | ------------ |
| ChatGPT ("Decay Edge")      | Score-based, soft stops   | All politicians                       | score² × 20% |
| Claude ("Decay Alpha")      | Score-based, take-profits | All politicians                       | $200 × score |
| Gemini ("Titan Conviction") | Pass/fail on 5 Titans     | Pelosi, Green, McCaul, Khanna, Larsen | Equal split  |

See [docs/ENGINE_SPEC.md](docs/ENGINE_SPEC.md) for full specification.

## Worker Package (@wolffm/trader-worker)

Published to GitHub Packages, imported by hadoku-site. Key exports:

- `createTraderHandler(env)` - Main request handler
- `createScheduledHandler(env)` - Cron job handler
- `runFullSync(env)` - Full sync (signals, prices, processing, performance)
- `backfillMarketPrices(env, start, end)` - Historical price backfill

Cron jobs (configured in hadoku-site's wrangler.toml):

- `0 */8 * * *` - Full sync every 8 hours
- `*/15 14-21 * * 1-5` - Position monitoring during market hours

## Development Commands

```bash
# Frontend
pnpm install && pnpm dev    # Start dev server
pnpm build                  # Production build

# Worker (tests)
cd worker && pnpm test      # Run agent tests

# Fidelity API
cd fidelity-api
pip install -e .
playwright install

# Local trade service
cd trader-worker
pip install -r requirements.txt
python main.py
```

## Conventions

1. Use `logger` from @wolffm/task-ui-components, not console.log
2. Use CSS variables from @wolffm/themes for all colors
3. Frontend mounts as child app - exports mount/unmount functions
4. All fidelity-api trade functions should use dry=True for testing

## Price Semantics (CRITICAL)

Understanding the difference between `trade_price` and `disclosure_price` is essential:

| Field              | What It Is                       | When                                                     |
| ------------------ | -------------------------------- | -------------------------------------------------------- |
| `trade_price`      | Stock price on `trade_date`      | When the politician actually executed the trade          |
| `disclosure_price` | Stock price on `disclosure_date` | When the trade was publicly disclosed (15-45 days later) |
| `current_price`    | Current market price             | At time of signal evaluation                             |

### Timeline

```
trade_date ──────────────────── disclosure_date ──────────── evaluation (now)
    │                                 │                              │
    │ <── disclosure lag ───>         │ <── days_since_filing ──>    │
    │      (15-45 days)               │      (0-14 days typically)   │
    │                                 │                              │
trade_price                    disclosure_price                current_price
```

### Price Change Metrics

- **`price_change_pct`**: `(current - trade_price) / trade_price × 100`
  - Total drift since politician's actual trade
  - **USED IN PRODUCTION** for filtering and scoring decisions

- **`disclosure_drift_pct`**: `(current - disclosure_price) / disclosure_price × 100`
  - Drift since public disclosure
  - **OBSERVABILITY ONLY** - not used in production scoring/filtering

### Why This Matters

1. **Scoring uses `trade_price`** - We measure alpha from when the politician traded, not when we learned about it
2. **Hard filters use `price_change_pct`** - Reject signals where price already moved >15-25%
3. **Dip bonus uses `price_change_pct`** - If price dropped since trade, that's a buying opportunity

## Signal Processing Flow

When a signal arrives:

1. Check for duplicates (by source_id)
2. Route to applicable agents (based on politician whitelist, asset types)
3. Each agent independently:
   - Applies hard filters (max age, max price move)
   - Calculates score (if scoring enabled)
   - Makes execute/skip decision based on threshold
   - Sizes position based on score and budget
4. Execute via Fidelity API (or queue for market hours)
5. Log full decision reasoning for audit

## API Routes

| Route                                 | Method | Description                |
| ------------------------------------- | ------ | -------------------------- |
| `/api/trader/signals`                 | GET    | List signals               |
| `/api/trader/signals`                 | POST   | Ingest signal from scraper |
| `/api/trader/signals/backfill`        | POST   | Batch signal backfill      |
| `/api/trader/signals/process`         | POST   | Process pending signals    |
| `/api/trader/agents`                  | GET    | List agents + performance  |
| `/api/trader/agents/:id`              | GET    | Agent details              |
| `/api/trader/performance`             | GET    | Overall performance        |
| `/api/trader/trades`                  | GET    | Trade history              |
| `/api/trader/sources`                 | GET    | Source leaderboard         |
| `/api/trader/execute`                 | POST   | Execute trade via tunnel   |
| `/api/trader/market/prices`           | GET    | Get market prices          |
| `/api/trader/market/tickers`          | GET    | Get tracked tickers        |
| `/api/trader/market/backfill`         | POST   | Backfill market prices     |
| `/api/trader/market/backfill/trigger` | POST   | Trigger market backfill    |
| `/api/trader/health`                  | GET    | Health check               |

## Important Constraints

- Never execute real trades without explicit confirmation
- Signal deduplication is critical to avoid double-buying
- Monthly budget caps ($1,000/agent) must be enforced
- All trades need audit logging with full reasoning chain
- Stop-loss and exit rules are monitored every 15 minutes during market hours

## Code Organization & Avoiding Duplication

**IMPORTANT: Before writing new code, check these canonical locations first.**

### Type Definitions - Where to Find Them

| Type Category                  | Canonical Location           | Notes                                                                 |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------- |
| Signal, Trade, Politician      | `worker/src/types.ts`        | Source of truth for API types                                         |
| Agent configs, scoring, sizing | `worker/src/agents/types.ts` | All trading engine types                                              |
| Frontend types                 | `src/types/api.ts`           | Mirrors worker types (don't duplicate, reference worker)              |
| Test utilities                 | `worker/src/agents/types.ts` | `RawSignal`, `TestPosition`, `TestClosedTrade`, `TestPoliticianStats` |

### Utility Functions - Where to Find Them

| Function                       | Location                          | Usage                                                  |
| ------------------------------ | --------------------------------- | ------------------------------------------------------ |
| `daysBetween(start, end)`      | `worker/src/agents/filters.ts`    | Date math - **DO NOT REDEFINE**                        |
| `generateId(prefix)`           | `worker/src/agents/filters.ts`    | ID generation                                          |
| `calculateDisclosureLagDays()` | `worker/src/utils.ts`             | Trade-to-disclosure lag                                |
| `insertSignalRow()`            | `worker/src/utils.ts`             | DB signal insertion (use `lenient: true` for backfill) |
| `buildPriceMap()`              | `worker/src/agents/test-utils.ts` | Latest prices from signals                             |
| `calculatePoliticianStats()`   | `worker/src/agents/test-utils.ts` | Politician performance                                 |
| `buildPoliticianFilters()`     | `worker/src/agents/test-utils.ts` | Top N politician filters                               |
| `annualizeReturn()`            | `worker/src/agents/test-utils.ts` | Return annualization                                   |

### Common Duplication Mistakes to Avoid

1. **`daysBetween` function** - This was duplicated in 3 places. Always import from `filters.ts` or via `./agents` index.

2. **Signal INSERT SQL** - The 25-column INSERT statement was duplicated. Use `insertSignalRow()` from `utils.ts`.

3. **Disclosure lag calculation** - Was inline in multiple places. Use `calculateDisclosureLagDays()`.

4. **Return percentage calculation** - Same loop pattern in multiple route handlers. Extract to a helper.

5. **Scoring breakdown types** - `ScoringBreakdown` was defined in multiple files. Now in `agents/types.ts`.

6. **Test type definitions** - `RawSignal`, `TestPosition`, etc. were in every test file. Now shared in `types.ts`.

### Import Patterns

```typescript
// For route handlers - import from ./agents index
import { daysBetween, calculateScoreSync } from './agents'
import type { ScoringBreakdown, EnrichedSignal } from './agents'

// For test files - import from test-utils
import { daysBetween, buildPriceMap, loadSignalsFromExport } from './test-utils'
import type { RawSignal, TestPosition } from './test-utils'

// For utils that need internal use AND re-export
import { daysBetween } from './filters'
export { daysBetween } // Re-export for consumers
```

### Export Structure

```
worker/src/index.ts           → Public package exports
worker/src/agents/index.ts    → All agent module exports
worker/src/agents/types.ts    → Type definitions
worker/src/agents/test-utils.ts → Test-specific utilities (re-exports from filters.ts)
```

### Before Adding New Code

1. **Search first**: `grep -r "functionName" worker/src/` to check if it exists
2. **Check indexes**: Look at `worker/src/agents/index.ts` for available exports
3. **Check types.ts**: Both `worker/src/types.ts` and `worker/src/agents/types.ts`
4. **Check test-utils.ts**: For any analysis/test utility functions

## Critical Rules for Tests

### NO HARDCODED LISTS IN PRODUCTION TESTS

**NEVER hardcode politician lists, Top 10 rankings, or other derived data in test files.**

Tests MUST compute dynamic values (like Top 10 politicians) using the same algorithm as production:

- Use `computePoliticianRankings()` from `rankings.ts` or equivalent logic
- Apply the same rolling window (e.g., 24 months) to available historical data
- Tests should match production behavior exactly

**Wrong:**

```typescript
const PRODUCTION_TOP_10 = ['Nancy Pelosi', 'Lisa McClain', ...] // NEVER DO THIS
```

**Right:**

```typescript
// Compute Top 10 dynamically from the last 24 months of available data
const top10 = computeTop10FromSignals(signals, { windowMonths: 24, minTrades: 15 })
```

This ensures:

1. Tests use the same algorithm as production
2. Rankings update automatically as data changes
3. No manual synchronization required between test and production
