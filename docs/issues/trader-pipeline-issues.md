# Trader Pipeline — Remaining Issues

Investigation date: 2026-02-28

The daily trader pipeline (`trader-api:daily-pipeline`) has not completed successfully since Feb 13. Rankings are stale (Feb 14), 13 signals sit unprocessed, and no trades have been evaluated in two weeks. Three root causes have been identified — all require changes in `@wolffm/trader-worker`.

---

## Issue 1: CF Worker Wall-Clock Timeout

**Severity:** Critical — this is why the pipeline is dead.

### Problem

`POST /internal/run-daily` runs three sequential phases in a single CF Worker request:

```
handleDailyPipeline(env)                         // workers/trader-api/src/index.ts:107
  ├─ await runFullSync(env)                      // @wolffm/trader-worker/dist/scheduled.js:64
  │    ├─ syncSignalsFromScraper(env)            //   paginated GET to scraper (network I/O)
  │    ├─ syncMarketPrices(env)                  //   POST to scraper with retry (network I/O)
  │    ├─ processAllPendingSignals(env)          //   per-signal scoring + D1 writes
  │    └─ updatePerformanceHistory(env)          //   D1 reads + writes
  ├─ await computePoliticianRankings(env)        // D1 aggregate queries + batch writes
  └─ await monitorPositions(env)                 // per-position market price fetch + exit logic
```

The CF Worker paid plan allows 30s CPU time per request, but the **wall-clock limit** is the real constraint. The pipeline was observed hanging for ~82s before being killed. The signal sync alone does paginated fetches to the scraper (network round trips through tunnel), and market price sync does POST requests with exponential backoff retry logic.

### Impact

- Pipeline killed mid-execution — no error response returned to orchestrator
- Orchestrator (mgmt-api `dispatchAndRecordJob`) hits its own 15s `DISPATCH_TIMEOUT_MS`, records failure
- All downstream work (rankings, position monitoring) never runs
- 13 signals unprocessed since Feb 13
- Rankings stale since Feb 14 (all 99 politicians computed in one batch on that date)

### Proposed Fix (in `@wolffm/trader-worker`)

Split `runFullSync` into independent phases that can be called separately, so the thin wrapper in `workers/trader-api/src/index.ts` can expose them as individual endpoints:

```
POST /internal/sync-signals       → syncSignalsFromScraper(env)
POST /internal/sync-prices        → syncMarketPrices(env)
POST /internal/process-signals    → processAllPendingSignals(env) + updatePerformanceHistory(env)
POST /internal/compute-rankings   → computePoliticianRankings(env)
POST /internal/monitor-positions  → monitorPositions(env)
```

The orchestrator in `services/mgmt-api/src/routes/cron.ts` would then call these sequentially with individual timeouts, rather than one monolithic request. Each phase should complete well within 30s wall-clock.

**Alternative:** If signal processing is the bottleneck (many signals × multiple agents), consider processing signals in batches (e.g., 5 at a time) with separate requests per batch.

---

## Issue 2: Fidelity Tunnel Auth Mismatch

**Severity:** High — trade execution is broken.

### Problem

`callFidelityApi()` in `@wolffm/trader-worker` sends the wrong auth header when calling the Fidelity proxy through edge-router.

**Current call chain:**

```
callFidelityApi(env, request)                    // @wolffm/trader-worker/dist/agents/execution.js:215
  └─ fetch(`${env.TUNNEL_URL}/execute-trade`)    // TUNNEL_URL = "https://hadoku.me/mgmt/api/fidelity"
       headers: { 'X-API-Key': env.TRADER_API_KEY }
```

**Edge-router auth for `/mgmt/*`:**

```
extractAuthKey(c, requestUrl)                    // workers/edge-router/src/proxy.ts:69
  1. X-User-Key header          → checked first
  2. X-API-Key header           → checked second  ← TRADER_API_KEY lands here
  3. Authorization: Bearer      → checked third
  4. Session cookie             → checked last

validateServiceOrAdminKey(key, env)              // workers/edge-router/src/auth.ts:61
  → checks key against ADMIN_KEYS and SERVICE_KEYS arrays
```

`extractAuthKey` extracts `TRADER_API_KEY` from the `X-API-Key` header, then `validateServiceOrAdminKey` checks it against `ADMIN_KEYS` and `SERVICE_KEYS`. `TRADER_API_KEY` is in neither list — it's a separate, trader-specific key. Auth fails silently (returns 404 per the route handler pattern).

The health check has the same problem:

```
handleHealth → fetch(`${env.TUNNEL_URL}/health`)  // @wolffm/trader-worker/dist/routes.js:530
  headers: { 'X-API-Key': env.TRADER_API_KEY }    // Same wrong key
```

This is why the trader health endpoint reports `trader_worker: disconnected`.

### Proposed Fix (in `@wolffm/trader-worker`)

**Option A — Add `ADMIN_KEYS` to `TraderEnv` and send `X-User-Key`:**

The package's `TraderEnv` interface needs a new optional field:

```typescript
// Current (types.d.ts:13-19)
export interface TraderEnv {
  TRADER_DB: D1Database
  SCRAPER_API_KEY: string
  TRADER_API_KEY: string
  TUNNEL_URL: string
  SCRAPER_URL: string
}

// Proposed
export interface TraderEnv {
  TRADER_DB: D1Database
  SCRAPER_API_KEY: string
  TRADER_API_KEY: string
  TUNNEL_URL: string
  SCRAPER_URL: string
  ADMIN_KEYS?: string // JSON array, first key used for edge-router auth
}
```

Then `callFidelityApi` and health check send `X-User-Key`:

```typescript
// execution.js — callFidelityApi
const adminKey = JSON.parse(env.ADMIN_KEYS || '[]')[0] || ''
const response = await fetch(tunnelUrl, {
  method: 'POST',
  headers: {
    'X-User-Key': adminKey, // edge-router auth
    'X-API-Key': env.TRADER_API_KEY, // downstream fidelity proxy auth
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(request)
})
```

After the package fix, set the secret on the worker:

```bash
wrangler secret put ADMIN_KEYS  # paste the JSON array
```

**Option B — Add `TRADER_API_KEY` to `SERVICE_KEYS`:**

Simpler but less clean — add the `TRADER_API_KEY` value to the edge-router's `SERVICE_KEYS` array. This would let `X-API-Key: TRADER_API_KEY` pass `validateServiceOrAdminKey`. No package change needed, but conflates key purposes.

### Recommended: Option A

Option A keeps key semantics clean and follows the same pattern used by monitoring-api and mgmt-api callers.

---

## Issue 3: Scraper Auth for trader-api (Edge-Router Bypass)

**Severity:** Medium — works but bypasses auth/logging.

### Problem

`@wolffm/trader-worker` calls the scraper directly via tunnel, bypassing edge-router:

```
syncSignalsFromScraper(env)                      // @wolffm/trader-worker/dist/scheduled.js:183
  └─ fetch(`${env.SCRAPER_URL}/api/v1/politrades/signals/pull?...`)
       headers: { Authorization: `Bearer ${env.SCRAPER_API_KEY}` }

syncMarketPrices(env) → fetchMarketPricesWithRetry
  └─ fetch(`${env.SCRAPER_URL}/api/v1/market/historical`)
       headers: { Authorization: `Bearer ${env.SCRAPER_API_KEY}` }
```

`SCRAPER_URL` is currently set to `https://scraper.hadoku.me` (direct tunnel). We added a `/scraper/*` route to edge-router (`https://hadoku.me/scraper`) that requires service/admin key auth — but the package only sends `Authorization: Bearer SCRAPER_API_KEY`, which is not a service/admin key.

### Proposed Fix (in `@wolffm/trader-worker`)

Same pattern as Issue 2 — once `ADMIN_KEYS` is added to `TraderEnv`, the scraper fetch calls should also send `X-User-Key`:

```typescript
// scheduled.js — syncSignalsFromScraper, fetchMarketPricesWithRetry
const adminKey = JSON.parse(env.ADMIN_KEYS || '[]')[0] || ''
const resp = await fetch(url, {
  headers: {
    'X-User-Key': adminKey,
    Authorization: `Bearer ${env.SCRAPER_API_KEY}`,
    Accept: 'application/json'
  }
})
```

After the package fix:

```bash
cd workers/trader-api
echo "https://hadoku.me/scraper" | wrangler secret put SCRAPER_URL
```

---

## Issue 4: Hardcoded Politician Whitelist (Stale Dynamic Filter)

**Severity:** Low — not a bug, but prevents dynamic ranking updates from taking effect.

### Problem

The `getActiveAgentsWithTopPoliticians()` function is designed to replace `null` whitelists with the current Top 10 from `politician_rankings`:

```javascript
// @wolffm/trader-worker/dist/agents/loader.js:340-362
export async function getActiveAgentsWithTopPoliticians(env, topN = 10) {
  const agents = await getActiveAgents(env)
  const topPoliticians = await getTopPoliticians(env, topN)
  return agents.map(agent => {
    // Only apply to agents with null whitelist
    if (agent.politician_whitelist === null && topPoliticians.length > 0) {
      return { ...agent, politician_whitelist: topPoliticians }
    }
    return agent // ← Decay Edge takes this path
  })
}
```

But the Decay Edge agent's `config_json` in D1 has a **hardcoded** `politician_whitelist` array (not `null`):

```json
{
  "id": "chatgpt",
  "name": "Decay Edge",
  "politician_whitelist": [
    "Lisa McClain",
    "Tim Moore",
    "John James",
    "Nancy Pelosi",
    "Rob Bresnahan",
    "David Taylor",
    "Bill Keating",
    "Tommy Tuberville",
    "Kathy Manning",
    "Ashley Moody"
  ]
}
```

Since `politician_whitelist !== null`, the dynamic Top 10 filter is never applied. The agent always uses these 10 hardcoded names regardless of ranking changes.

### Current State

These 10 names happen to match what the Top 10 rankings were when they were last computed (Feb 14). But if rankings shift after new signals are processed, the agent would continue filtering on the stale list.

### Proposed Fix

This is a data fix, not a code fix. Set `politician_whitelist` to `null` in the agent's config so the dynamic filter activates:

```sql
UPDATE agents
SET config_json = json_set(config_json, '$.politician_whitelist', json('null')),
    updated_at = datetime('now')
WHERE id = 'chatgpt';
```

**However**, this should only be done after Issue 1 is fixed and the pipeline is running again — otherwise there are no fresh rankings to pull from and `getTopPoliticians` would return the same stale Feb 14 data or an empty list.

---

## Dependency Order

```
Issue 1 (wall-clock timeout)     ← fix first, unblocks pipeline
  → pipeline runs again
  → signals processed, rankings refreshed
Issue 2 (fidelity auth)          ← fix second, unblocks trade execution
Issue 3 (scraper auth bypass)    ← fix third, routes scraper through edge-router
Issue 4 (hardcoded whitelist)    ← fix last, after pipeline produces fresh rankings
```

All four share a common prerequisite: adding `ADMIN_KEYS?: string` to `TraderEnv` in `@wolffm/trader-worker`. Issues 1-3 are package code changes; Issue 4 is a D1 data update that should wait until the pipeline is healthy.
