# Hadoku Trader Worker

Cloudflare Worker API for the hadoku-trader system. Designed as an importable package for hadoku-site.

## Overview

This worker provides:
- **Signal Ingestion**: POST endpoint for hadoku-scraper to submit congressional trade signals
- **REST API**: Endpoints for the dashboard to fetch data
- **Trade Execution Proxy**: Forwards trade requests to local trader-worker via cloudflared tunnel

## Installation in hadoku-site

### 1. Add as a dependency

```bash
# Using file protocol (recommended for local development)
cd /path/to/hadoku-site
pnpm add ../hadoku-trader/worker

# Or using git URL
pnpm add git+https://github.com/hadoku/hadoku-trader.git#main:worker
```

### 2. Import and mount in your worker

```typescript
// hadoku-site/src/worker.ts
import { createTraderHandler, type TraderEnv, isTraderRoute } from '@wolffm/trader-worker';

// Extend your env to include TraderEnv
interface Env extends TraderEnv {
  // Your other bindings...
  KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Mount trader routes at /api/trader/*
    if (isTraderRoute(url.pathname)) {
      const traderHandler = createTraderHandler(env);
      return traderHandler(request);
    }

    // ... your other routes
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Import scheduled handler if you need cron jobs
    const { createScheduledHandler } = await import('@wolffm/trader-worker');
    const handler = createScheduledHandler(env);
    await handler(event.cron);
  }
}
```

### 3. Configure wrangler.toml

```toml
# D1 Database
[[d1_databases]]
binding = "TRADER_DB"
database_name = "trader-db"
database_id = "YOUR_DATABASE_ID"

# Scheduled triggers (optional)
[triggers]
crons = [
  "0 0 * * *",    # Daily: update performance history
  "0 */8 * * *"  # Every 8 hours: sync portfolio
]
```

### 4. Set secrets

```bash
wrangler secret put SCRAPER_API_KEY
wrangler secret put TRADER_API_KEY
wrangler secret put TUNNEL_URL
```

### 5. Create and migrate D1

```bash
wrangler d1 create trader-db
wrangler d1 execute trader-db --file=./node_modules/@wolffm/trader-worker/schema.sql
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/trader/signals | - | Get all signals |
| POST | /api/trader/signals | SCRAPER_API_KEY | Submit new signal |
| POST | /api/trader/signals/backfill | SCRAPER_API_KEY | Batch signal backfill |
| POST | /api/trader/signals/process | TRADER_API_KEY | Process pending signals |
| GET | /api/trader/performance | - | Get performance metrics |
| GET | /api/trader/trades | - | Get trade history |
| GET | /api/trader/sources | - | Get source leaderboard |
| GET | /api/trader/agents | - | Get all agents with budget info |
| GET | /api/trader/agents/:id | - | Get agent details with positions |
| POST | /api/trader/execute | TRADER_API_KEY | Execute a trade |
| GET | /api/trader/health | - | Health check |
| GET | /api/trader/market/prices | - | Get market prices |
| GET | /api/trader/market/tickers | - | Get tracked tickers |
| POST | /api/trader/market/backfill | TRADER_API_KEY | Backfill market prices |
| POST | /api/trader/market/backfill/trigger | TRADER_API_KEY | Trigger market backfill |

## Local Development

For standalone local development:

```bash
cd worker
pnpm install
pnpm db:migrate:local
pnpm dev
```

## Exports

```typescript
// Main handler factory
import { createTraderHandler, isTraderRoute } from '@wolffm/trader-worker';

// Scheduled tasks
import { createScheduledHandler } from '@wolffm/trader-worker';

// Individual route handlers (for custom routing)
import {
  handleGetSignals,
  handlePostSignal,
  handleBackfillBatch,
  handleGetPerformance,
  handleGetTrades,
  handleGetSources,
  handleGetAgents,
  handleGetAgentById,
  handleExecuteTrade,
  handleHealth,
  handleProcessSignals,
  handleGetMarketPrices,
  handleMarketPricesBackfill,
} from '@wolffm/trader-worker';

// Types
import type {
  TraderEnv,
  Signal,
  ExecuteTradeRequest,
  ExecuteTradeResponse,
  // ... all types
} from '@wolffm/trader-worker';

// Or import types separately
import type { Signal } from '@wolffm/trader-worker/types';
```

## Building

```bash
pnpm build  # Outputs to dist/
```

This generates TypeScript declaration files so hadoku-site gets full type support.
