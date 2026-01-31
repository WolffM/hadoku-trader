# Hadoku-Site: Politician Rankings Implementation

## Overview

Add a `politician_rankings` table and API endpoint to compute and store politician performance rankings with a rolling window. This enables dynamic Top N politician filters for trading agents.

---

## 1. Database Migration

Create a new migration file: `migrations/XXXX_add_politician_rankings.sql`

```sql
-- Politician rankings with rolling window performance stats
CREATE TABLE IF NOT EXISTS politician_rankings (
  politician_name TEXT PRIMARY KEY,
  politician_party TEXT,           -- 'D' or 'R'
  politician_chamber TEXT,         -- 'house' or 'senate'
  window_months INTEGER NOT NULL DEFAULT 24,
  total_trades INTEGER NOT NULL DEFAULT 0,
  closed_trades INTEGER NOT NULL DEFAULT 0,
  total_return_pct REAL NOT NULL DEFAULT 0,
  annualized_return_pct REAL NOT NULL DEFAULT 0,
  avg_hold_days REAL,
  rank INTEGER,
  computed_at TEXT NOT NULL
);

-- Index for efficient top N queries
CREATE INDEX IF NOT EXISTS idx_politician_rankings_rank
  ON politician_rankings(rank) WHERE rank IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_politician_rankings_annualized
  ON politician_rankings(annualized_return_pct DESC);
```

---

## 2. API Endpoints

### POST `/api/trader/politicians/compute-rankings`

Computes politician rankings from signal history and stores in D1.

**Request:**

```json
{
  "window_months": 24, // Optional, default 24
  "min_trades": 15 // Optional, minimum trades to qualify for ranking
}
```

**Response:**

```json
{
  "success": true,
  "computed_at": "2026-01-31T12:00:00Z",
  "total_politicians": 150,
  "qualified_politicians": 42,
  "top_10": [
    {
      "rank": 1,
      "politician_name": "Nancy Pelosi",
      "politician_party": "D",
      "total_trades": 87,
      "closed_trades": 65,
      "annualized_return_pct": 45.2
    }
  ]
}
```

### GET `/api/trader/politicians/rankings`

Returns current rankings from the table.

**Query params:**

- `limit` - Number of results (default 10)
- `min_trades` - Filter by minimum trades

**Response:**

```json
{
  "rankings": [
    {
      "rank": 1,
      "politician_name": "Nancy Pelosi",
      "politician_party": "D",
      "politician_chamber": "house",
      "total_trades": 87,
      "closed_trades": 65,
      "total_return_pct": 125.5,
      "annualized_return_pct": 45.2,
      "avg_hold_days": 42,
      "computed_at": "2026-01-31T12:00:00Z"
    }
  ],
  "computed_at": "2026-01-31T12:00:00Z"
}
```

### GET `/api/trader/politicians/top`

Convenience endpoint returning just politician names for agent filtering.

**Query params:**

- `n` - Number of politicians (default 10)

**Response:**

```json
{
  "politicians": ["Nancy Pelosi", "Pete Sessions", "Cleo Fields"],
  "computed_at": "2026-01-31T12:00:00Z"
}
```

---

## 3. Route Handler Implementation

Import the computation function from `@wolffm/trader-worker`:

```typescript
import { computePoliticianRankings, type PoliticianRanking } from '@wolffm/trader-worker'

// POST /api/trader/politicians/compute-rankings
export async function handleComputeRankings(request: Request, env: TraderEnv): Promise<Response> {
  const body = await request.json()
  const windowMonths = body.window_months ?? 24
  const minTrades = body.min_trades ?? 15

  // Compute rankings (function exported from trader-worker)
  const result = await computePoliticianRankings(env, {
    windowMonths,
    minTrades
  })

  return jsonResponse(result)
}

// GET /api/trader/politicians/rankings
export async function handleGetRankings(request: Request, env: TraderEnv): Promise<Response> {
  const url = new URL(request.url)
  const limit = parseInt(url.searchParams.get('limit') ?? '10')

  const results = await env.TRADER_DB.prepare(
    `
    SELECT * FROM politician_rankings
    WHERE rank IS NOT NULL
    ORDER BY rank ASC
    LIMIT ?
  `
  )
    .bind(limit)
    .all()

  return jsonResponse({
    rankings: results.results,
    computed_at: results.results[0]?.computed_at ?? null
  })
}

// GET /api/trader/politicians/top
export async function handleGetTopPoliticians(request: Request, env: TraderEnv): Promise<Response> {
  const url = new URL(request.url)
  const n = parseInt(url.searchParams.get('n') ?? '10')

  const results = await env.TRADER_DB.prepare(
    `
    SELECT politician_name, computed_at FROM politician_rankings
    WHERE rank IS NOT NULL AND rank <= ?
    ORDER BY rank ASC
  `
  )
    .bind(n)
    .all()

  return jsonResponse({
    politicians: results.results.map(r => r.politician_name),
    computed_at: results.results[0]?.computed_at ?? null
  })
}
```

---

## 4. Add Routes to Handler

In your main request handler:

```typescript
// Politicians
if (path === '/api/trader/politicians/compute-rankings' && method === 'POST') {
  return handleComputeRankings(request, env)
}
if (path === '/api/trader/politicians/rankings' && method === 'GET') {
  return handleGetRankings(request, env)
}
if (path === '/api/trader/politicians/top' && method === 'GET') {
  return handleGetTopPoliticians(request, env)
}
```

---

## 5. Scheduled Job (Optional)

Add a daily cron to refresh rankings:

```typescript
// In scheduled.ts or similar
export async function refreshPoliticianRankings(env: TraderEnv) {
  await computePoliticianRankings(env, {
    windowMonths: 24,
    minTrades: 15
  })
}
```

In `wrangler.toml`:

```toml
[triggers]
crons = [
  "0 6 * * *",  # Daily at 6am UTC - refresh rankings
]
```

---

## 6. Update Package Version

After implementing, bump `@wolffm/trader-worker` version in hadoku-trader and publish.

Then update in hadoku-site:

```bash
pnpm update @wolffm/trader-worker
```

---

## 7. Testing

Test endpoints after deployment:

```bash
# Compute rankings
curl -X POST https://your-site.com/api/trader/politicians/compute-rankings \
  -H "Content-Type: application/json" \
  -d '{"window_months": 24, "min_trades": 15}'

# Get rankings
curl https://your-site.com/api/trader/politicians/rankings?limit=10

# Get top N names only
curl https://your-site.com/api/trader/politicians/top?n=10
```
