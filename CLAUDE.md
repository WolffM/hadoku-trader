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
│   └── SITE_INTEGRATION.md   # How to integrate with hadoku-site
└── package.json
```

## Multi-Agent Trading Engine

Three agents run independently with $1,000/month budget each:

| Agent | Strategy | Signals | Sizing |
|-------|----------|---------|--------|
| ChatGPT ("Decay Edge") | Score-based, soft stops | All politicians | score² × 20% |
| Claude ("Decay Alpha") | Score-based, take-profits | All politicians | $200 × score |
| Gemini ("Titan Conviction") | Pass/fail on 5 Titans | Pelosi, Green, McCaul, Khanna, Larsen | Equal split |

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

| Route | Method | Description |
|-------|--------|-------------|
| `/api/trader/signals` | GET | List signals |
| `/api/trader/signals` | POST | Ingest signal from scraper |
| `/api/trader/signals/backfill` | POST | Batch signal backfill |
| `/api/trader/agents` | GET | List agents + performance |
| `/api/trader/agents/:id` | GET | Agent details |
| `/api/trader/performance` | GET | Overall performance |
| `/api/trader/trades` | GET | Trade history |
| `/api/trader/execute` | POST | Execute trade via tunnel |
| `/api/trader/simulation/run` | POST | Run backtest simulation |
| `/api/trader/market/prices` | GET | Get market prices |

## Important Constraints

- Never execute real trades without explicit confirmation
- Signal deduplication is critical to avoid double-buying
- Monthly budget caps ($1,000/agent) must be enforced
- All trades need audit logging with full reasoning chain
- Stop-loss and exit rules are monitored every 15 minutes during market hours
