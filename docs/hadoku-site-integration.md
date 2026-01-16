# Hadoku-Site Integration Guide

This document shows how to integrate the hadoku-trader packages into hadoku-site.

## Packages Published

| Package | Registry | Purpose |
|---------|----------|---------|
| `@wolffm/trader` | GitHub npm | React dashboard UI components |
| `@wolffm/trader-worker` | GitHub npm | Cloudflare Worker API routes |
| `hadoku-fidelity` | PyPI | Python trading service (FastAPI) |

---

## 1. React UI (`@wolffm/trader`)

### Installation

```bash
pnpm add @wolffm/trader
```

### Usage in hadoku-site

```tsx
// src/pages/trader.tsx
import { TraderDashboard } from '@wolffm/trader';
import '@wolffm/trader/style.css';

export default function TraderPage() {
  return <TraderDashboard />;
}
```

---

## 2. Cloudflare Worker API (`@wolffm/trader-worker`)

### Installation

```bash
pnpm add @wolffm/trader-worker
```

### Usage in hadoku-site worker

```typescript
// src/worker.ts
import {
  createTraderHandler,
  isTraderRoute,
  type TraderEnv
} from '@wolffm/trader-worker';

// Extend your env to include trader bindings
interface Env extends TraderEnv {
  // Your other bindings...
  KV: KVNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Mount trader API at /api/trader/*
    if (isTraderRoute(url.pathname)) {
      const handler = createTraderHandler(env);
      return handler(request);
    }

    // ... your other routes
    return env.ASSETS.fetch(request);
  },

  // Optional: scheduled tasks
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const { createScheduledHandler } = await import('@wolffm/trader-worker');
    const handler = createScheduledHandler(env);
    await handler(event.cron);
  }
};
```

### wrangler.toml additions

```toml
# D1 Database for trader
[[d1_databases]]
binding = "TRADER_DB"
database_name = "trader-db"
database_id = "YOUR_DATABASE_ID"

# Cron triggers (optional)
[triggers]
crons = [
  "0 0 * * *",    # Daily: update performance history
  "0 */8 * * *"  # Every 8 hours: sync portfolio
]
```

### Secrets to add

```bash
wrangler secret put SCRAPER_API_KEY    # For hadoku-scraper to post signals
wrangler secret put TRADER_API_KEY     # For trade execution
wrangler secret put TUNNEL_URL         # cloudflared tunnel to local service
```

### D1 Migration

```bash
# Copy schema from package
cp node_modules/@wolffm/trader-worker/schema.sql ./migrations/

# Create and migrate
wrangler d1 create trader-db
wrangler d1 execute trader-db --file=./migrations/schema.sql
```

---

## 3. Python Trading Service (`hadoku-fidelity`)

### Installation

```bash
pip install hadoku-fidelity
```

### Usage - Simple (with CLI)

```bash
# Run directly
hadoku-trader --port 8765

# Or with PM2
pm2 start "hadoku-trader --port 8765" --name trader-service
```

### Usage - Custom wrapper (recommended)

```python
# services/trader/main.py
from hadoku_fidelity import create_app

app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
```

### PM2 ecosystem config

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'trader-service',
      script: 'hadoku-trader',
      args: '--port 8765',
      cwd: './services/trader',
      env: {
        FIDELITY_USERNAME: process.env.FIDELITY_USERNAME,
        FIDELITY_PASSWORD: process.env.FIDELITY_PASSWORD,
        FIDELITY_TOTP_SECRET: process.env.FIDELITY_TOTP_SECRET,
        FIDELITY_DEFAULT_ACCOUNT: process.env.FIDELITY_DEFAULT_ACCOUNT,
        TRADER_API_SECRET: process.env.TRADER_API_SECRET,
      }
    }
  ]
};
```

### Environment variables

```env
# .env (local machine running PM2)
FIDELITY_USERNAME=your_username
FIDELITY_PASSWORD=your_password
FIDELITY_TOTP_SECRET=your_totp_secret
FIDELITY_DEFAULT_ACCOUNT=X12345678
TRADER_API_SECRET=your_api_secret
TRADER_WORKER_PORT=8765
```

---

## Architecture Flow

```
hadoku-scraper
       │ POST /api/trader/signals
       ▼
┌──────────────────────────────────────────────────────┐
│  hadoku-site (Cloudflare Worker)                     │
│                                                      │
│  @wolffm/trader (UI)  ◄──►  @wolffm/trader-worker   │
│                              │                       │
│                              │ D1 (signals, trades)  │
│                              │                       │
│                              │ POST /execute-trade   │
└──────────────────────────────│───────────────────────┘
                               │ cloudflared tunnel
                               ▼
┌──────────────────────────────────────────────────────┐
│  Local Machine (PM2)                                 │
│                                                      │
│  hadoku-fidelity (FastAPI)                           │
│       └── FidelityClient (browser automation)        │
└──────────────────────────────────────────────────────┘
```

---

## Quick Start Checklist

### In hadoku-site:

1. [ ] `pnpm add @wolffm/trader @wolffm/trader-worker`
2. [ ] Add TraderEnv bindings to worker
3. [ ] Mount trader routes with `createTraderHandler`
4. [ ] Create D1 database and run migration
5. [ ] Set worker secrets (SCRAPER_API_KEY, TRADER_API_KEY, TUNNEL_URL)

### On local machine:

1. [ ] `pip install hadoku-fidelity`
2. [ ] Set up .env with Fidelity credentials
3. [ ] Add to PM2 ecosystem
4. [ ] Set up cloudflared tunnel
5. [ ] Point TUNNEL_URL secret to tunnel URL
