# Hadoku Trader Worker

Cloudflare Worker API for the hadoku-trader system.

## Overview

This worker provides:
- **Signal Ingestion**: POST endpoint for hadoku-scraper to submit congressional trade signals
- **REST API**: Endpoints for the dashboard to fetch data
- **Trade Execution Proxy**: Forwards trade requests to local trader-worker via cloudflared tunnel

## Integration with hadoku-site

This worker is designed to be exported to hadoku-site. To integrate:

### 1. Copy files to hadoku-site

```bash
# Copy worker source
cp -r worker/src/* ../hadoku-site/src/workers/trader/

# Copy schema
cp worker/schema.sql ../hadoku-site/d1/trader-schema.sql
```

### 2. Add to hadoku-site's wrangler.toml

```toml
# D1 Database
[[d1_databases]]
binding = "TRADER_DB"
database_name = "trader-db"
database_id = "YOUR_DATABASE_ID"

# Add routes
[[routes]]
pattern = "hadoku.me/api/trader/*"
```

### 3. Set secrets

```bash
wrangler secret put SCRAPER_API_KEY
wrangler secret put TRADER_API_KEY
wrangler secret put TUNNEL_URL
```

### 4. Create and migrate D1

```bash
wrangler d1 create trader-db
wrangler d1 execute trader-db --file=./d1/trader-schema.sql
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/trader/signals | - | Get all signals |
| POST | /api/trader/signals | SCRAPER_API_KEY | Submit new signal |
| GET | /api/trader/performance | - | Get performance metrics |
| GET | /api/trader/portfolio | - | Get current positions |
| GET | /api/trader/trades | - | Get trade history |
| GET | /api/trader/sources | - | Get source leaderboard |
| POST | /api/trader/execute | TRADER_API_KEY | Execute a trade |
| GET | /api/trader/health | - | Health check |

## Local Development

```bash
# Install dependencies
pnpm install

# Create local D1
pnpm db:migrate:local

# Start dev server
pnpm dev
```

## Types

The `src/types.ts` file contains all TypeScript types shared between:
- This worker
- The dashboard frontend
- hadoku-scraper

Export these types to other projects as needed.
