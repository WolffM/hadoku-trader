# Claude Code Instructions for hadoku-trader

## Project Context

This is a congressional trade copying system. The goal is to:
1. Receive signals from hadoku-scraper about congressional stock trades
2. Display a dashboard showing signal/portfolio performance vs benchmarks
3. Eventually auto-execute trades via Fidelity

## Current State

- **Frontend**: Basic React skeleton with theme integration (working)
- **Backend**: Handled by hadoku-site Cloudflare Worker (separate repo)
- **Fidelity API**: Forked Python library, runs locally via PM2 + cloudflared tunnel

## Architecture

```
hadoku-scraper ──► hadoku-site (CF Worker + D1) ──► hadoku-trader (Dashboard)
                                                          │
                                                          ▼ trade requests
                                    hadoku-site ──► Local PM2 (fidelity-api via tunnel)
```

Data flow:
1. hadoku-site fetches data from hadoku-scraper every 8 hours
2. Data stored in D1 (Cloudflare's SQLite)
3. Dashboard fetches data via REST API from hadoku-site
4. Trade execution: dashboard → hadoku-site → cloudflared tunnel → local PM2 → fidelity-api

## Tech Stack

### Frontend (this repo)
- React 19 + TypeScript
- Vite for bundling
- @wolffm/themes for theming
- @wolffm/task-ui-components for shared UI
- Publishes to GitHub Packages as @wolffm/trader

### Backend (hadoku-site repo)
- Cloudflare Workers
- D1 database (SQLite)
- Scheduled triggers for data fetching

### Trade Execution (local)
- PM2 process manager
- cloudflared tunnel
- Python + fidelity-api

## File Structure

```
hadoku-trader/
├── src/                    # React frontend
│   ├── App.tsx            # Main component
│   ├── entry.tsx          # Mount/unmount exports
│   ├── hooks/             # Custom hooks
│   └── styles/            # CSS
├── fidelity-api/          # Forked broker automation
│   └── fidelity/
│       └── fidelity.py    # FidelityAutomation class
├── docs/
│   ├── requirements.md    # Full system spec
│   └── scrapeRequirements.md  # Signal schema
└── package.json
```

## Key Classes

### FidelityAutomation (Python)
Main methods:
- `login(username, password, totp_secret, save_device)` - Returns (step1_success, step2_success)
- `getAccountInfo()` - Returns dict of accounts with positions
- `transaction(stock, quantity, action, account, dry)` - Execute trade, returns (success, error)
- `transfer_acc_to_acc(source, dest, amount)` - Transfer funds
- `get_list_of_accounts()` - Get all accounts with balances

## Development Commands

```bash
# Frontend
pnpm install && pnpm dev    # Start dev server
pnpm build                  # Production build

# Fidelity API
cd fidelity-api
pip install -e .
playwright install
```

## Conventions

1. Use `logger` from @wolffm/task-ui-components, not console.log
2. Use CSS variables from @wolffm/themes for all colors
3. Frontend mounts as child app - exports mount/unmount functions
4. All fidelity-api trade functions should use dry=True for testing

## Signal Processing Logic

When a signal arrives:
1. Check for duplicates (by source_id)
2. If duplicate from new source → increase conviction multiplier
3. Calculate "priced in" score based on days since disclosure and price movement
4. Size position based on: politician's trade size × conviction × priced-in discount
5. Execute or skip based on budget remaining
6. Log everything for audit

## Dashboard Sections

Build these views:
1. Overview - Total value, returns vs SPY
2. Portfolio - Current positions with P&L
3. Trade Log - History with reasoning
4. Source Leaderboard - Which sources generate alpha
5. Signals Feed - Incoming signals status
6. Budget - Monthly cap utilization

## Important Constraints

- Never execute real trades without explicit confirmation
- Signal deduplication is critical to avoid double-buying
- Monthly budget caps must be enforced
- All trades need audit logging with full reasoning chain
