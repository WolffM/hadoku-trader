# @wolffm/trader (Congress Trade Copier)

A trading dashboard and automation system that copies congressional stock trades. Integrates with hadoku-scraper for signals and uses fidelity-api for trade execution.

## Overview

This project has two main components:

1. **Frontend Dashboard** - React app displaying signal performance, portfolio tracking, and comparisons with benchmarks (S&P500, NANC, KRUZ)
2. **Trade Execution Backend** - FastAPI service that receives signals from hadoku-scraper and executes trades via Fidelity

## Architecture

```
┌─────────────────┐     every 8hrs      ┌──────────────────┐
│ hadoku-scraper  │ ◄────────────────── │  hadoku-site     │
│                 │    fetch signals    │  (CF Worker)     │
│ • Congress data │ ──────────────────► │  • D1 database   │
│ • S&P500 data   │    return package   │  • API endpoints │
│ • Market prices │                     └────────┬─────────┘
└─────────────────┘                              │
                                                 │ REST API
                                                 ▼
                                    ┌────────────────────────┐
                                    │  hadoku-trader         │
                                    │  (Dashboard on gh-pages)│
                                    │  • Signal performance  │
                                    │  • Portfolio tracking  │
                                    │  • S&P500 comparison   │
                                    └────────────┬───────────┘
                                                 │
                                                 │ trade requests
                                                 ▼
┌─────────────────┐  cloudflared tunnel ┌────────────────────┐
│  Local PM2      │ ◄────────────────── │  hadoku-site       │
│  Trade Service  │                     │  (forwards request)│
│  • fidelity-api │                     └────────────────────┘
│  • Playwright   │
└─────────────────┘
```

### Components

1. **hadoku-scraper** - External service providing all market data
2. **hadoku-site (CF Worker)** - API layer with D1 storage, fetches data every 8hrs
3. **hadoku-trader (this repo)** - Dashboard UI + fidelity-api package
4. **Local PM2 Service** - Runs fidelity-api via cloudflared tunnel for trade execution

## Dashboard Features

1. **Overview** - Total value, MTD/YTD return, vs SPY
2. **Live Portfolio** - Current positions with cost basis and P&L
3. **Trade Log** - Every trade with reasoning chain visible
4. **Source Leaderboard** - Which trackers are generating alpha
5. **Signals Feed** - Incoming signals, executed vs skipped
6. **Monthly Budget** - Visual of cap utilization

## Development

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Build for production
pnpm build

# Lint and format
pnpm lint:fix
pnpm format
```

### Logging

Use the logger from `@wolffm/task-ui-components` instead of `console.log`:

```typescript
import { logger } from '@wolffm/task-ui-components'

logger.info('Message', { key: 'value' })
logger.error('Error occurred', error)
```

## Fidelity API

The `fidelity-api/` directory contains a forked Playwright-based automation library for Fidelity. Key capabilities:

- **Authentication** - Login with 2FA support (TOTP or SMS)
- **Account Info** - Get accounts, balances, positions
- **Trading** - Buy/sell stocks with market or limit orders, extended hours support
- **Transfers** - Move funds between accounts
- **Features** - Enable penny stock trading, download statements

See [fidelity-api/README.md](fidelity-api/README.md) for usage details.

## Integration

This app is a child component of the [hadoku_site](https://github.com/WolffM/hadoku_site) parent application.

### Props

```typescript
interface TraderProps {
  theme?: string // 'light', 'dark', 'coffee-dark', etc.
}
```

### Mounting

```typescript
import { mount, unmount } from '@wolffm/trader'

mount(document.getElementById('app-root'), { theme: 'ocean-dark' })
unmount(document.getElementById('app-root'))
```

## Deployment

Pushes to `main` automatically:

1. Build and publish to GitHub Packages
2. Notify parent site to update
3. Parent pulls new version and redeploys

## Theme Integration

Use CSS variables from `@wolffm/themes`:

```css
background-color: var(--color-bg);
color: var(--color-text);
border-color: var(--color-border);
```

## Related Repositories

- [hadoku_site](https://github.com/WolffM/hadoku_site) - Parent application
- hadoku-scraper - Signal source (congressional trade tracking)
