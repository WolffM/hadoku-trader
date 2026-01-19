# hadoku-site Integration Guide

Integration instructions for connecting hadoku-site to the trader-worker analysis engine and fidelity-api execution.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ hadoku-site (CF Worker)                                                     │
│ ├─ Cron: 0 */8 * * * (every 8 hours)                                        │
│ ├─ Imports: @wolffm/trader-worker                                           │
│ └─ Dispatches via: mgmt-api → fidelity-api tunnel                           │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
  hadoku-scraper              trader-worker               fidelity-api
  (provides signals           (analyzes signals,          (executes trades
   with current_price)         returns actions)            via browser)
```

## Flow

```
8hr cron triggers
    │
    ├─ 1. Fetch signals from hadoku-scraper
    │     └─ Scraper already provides current_price
    │
    ├─ 2. Enrich signals (compute 3 trivial fields)
    │     └─ days_since_trade, days_since_filing, price_change_pct
    │
    ├─ 3. Call trader-worker.analyzeSignals()
    │     └─ Returns TradeAction[] with decisions for each agent
    │
    ├─ 4. Queue execute actions in D1
    │     └─ INSERT into trades with status='pending'
    │
    ├─ 5. Dispatch via mgmt-api → fidelity-api
    │     └─ For each pending trade, call tunnel
    │
    └─ 6. Update D1 on result
          └─ trades, positions, agent_budgets
```

---

## 1. Install Package

```bash
pnpm add @wolffm/trader-worker@latest
```

## 2. Imports

```typescript
import {
  analyzeSignals,
  type TradeAction,
  type EnrichedSignal,
  type TraderEnv,
} from '@wolffm/trader-worker';
```

## 3. Signal Enrichment

Scraper provides most fields. You only compute 3 trivial derived fields:

```typescript
interface ScraperSignal {
  id: string;
  ticker: string;
  action: 'buy' | 'sell';
  asset_type: 'stock' | 'etf' | 'option';
  trade_price: number;
  current_price: number;      // Already provided by scraper!
  trade_date: string;
  disclosure_date: string;
  position_size_min: number;
  politician_name: string;
  source: string;
}

function enrichSignals(rawSignals: ScraperSignal[]): EnrichedSignal[] {
  const today = new Date();

  return rawSignals.map(signal => {
    const tradeDate = new Date(signal.trade_date);
    const disclosureDate = new Date(signal.disclosure_date);

    return {
      // Pass through from scraper (no changes)
      id: signal.id,
      ticker: signal.ticker,
      action: signal.action,
      asset_type: signal.asset_type,
      trade_price: signal.trade_price,
      current_price: signal.current_price,
      trade_date: signal.trade_date,
      disclosure_date: signal.disclosure_date,
      position_size_min: signal.position_size_min,
      politician_name: signal.politician_name,
      source: signal.source,

      // Compute these 3 fields
      days_since_trade: Math.floor(
        (today.getTime() - tradeDate.getTime()) / (1000 * 60 * 60 * 24)
      ),
      days_since_filing: Math.floor(
        (today.getTime() - disclosureDate.getTime()) / (1000 * 60 * 60 * 24)
      ),
      price_change_pct:
        ((signal.current_price - signal.trade_price) / signal.trade_price) * 100,
    };
  });
}
```

## 4. Main Scheduled Handler

```typescript
export async function handleScheduled(env: Env): Promise<{
  signals_fetched: number;
  actions_analyzed: number;
  trades_queued: number;
  trades_dispatched: number;
  trades_succeeded: number;
  trades_failed: number;
}> {
  // Step 1: Fetch signals from scraper
  const rawSignals = await fetchFromScraper(env);

  // Step 2: Enrich with computed fields
  const enrichedSignals = enrichSignals(rawSignals);

  // Step 3: Analyze signals (get trade decisions)
  const actions = await analyzeSignals(env, enrichedSignals);

  // Step 4: Filter to only execute actions
  const toExecute = actions.filter(a =>
    a.decision === 'execute' || a.decision === 'execute_half'
  );

  // Step 5: Queue trades in D1
  await queueTrades(env, toExecute);

  // Step 6: Dispatch pending trades
  const dispatchResult = await dispatchPendingTrades(env);

  return {
    signals_fetched: rawSignals.length,
    actions_analyzed: actions.length,
    trades_queued: toExecute.length,
    ...dispatchResult,
  };
}
```

## 5. Fetch from Scraper

```typescript
async function fetchFromScraper(env: Env): Promise<ScraperSignal[]> {
  const response = await fetch(`${env.SCRAPER_URL}/data-package`, {
    headers: {
      'X-API-Key': env.SCRAPER_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Scraper error: ${response.status}`);
  }

  const data = await response.json();
  return data.signals;
}
```

## 6. Queue Trades in D1

```typescript
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function queueTrades(env: Env, actions: TradeAction[]): Promise<void> {
  const now = new Date().toISOString();

  for (const action of actions) {
    await env.TRADER_DB.prepare(`
      INSERT INTO trades (
        id, agent_id, signal_id, ticker, action, decision,
        score, score_breakdown_json, quantity, price, total,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(
      generateId('trade'),
      action.agent_id,
      action.signal_id,
      action.ticker,
      action.action,
      action.decision,
      action.score,
      action.score_breakdown ? JSON.stringify(action.score_breakdown) : null,
      action.quantity,
      action.current_price,
      action.position_size,
      now
    ).run();
  }
}
```

## 7. Dispatch Pending Trades

```typescript
interface DispatchResult {
  trades_dispatched: number;
  trades_succeeded: number;
  trades_failed: number;
}

async function dispatchPendingTrades(env: Env): Promise<DispatchResult> {
  // Get pending trades
  const pending = await env.TRADER_DB.prepare(`
    SELECT * FROM trades
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 20
  `).all();

  let succeeded = 0;
  let failed = 0;

  for (const trade of pending.results as any[]) {
    try {
      // Call mgmt-api → fidelity-api
      const result = await callMgmtApi(env, {
        ticker: trade.ticker,
        action: trade.action,
        quantity: trade.quantity,
        dry_run: false,  // Set true for testing!
      });

      if (result.success) {
        // Update trade as executed
        await env.TRADER_DB.prepare(`
          UPDATE trades
          SET status = 'executed', executed_at = ?
          WHERE id = ?
        `).bind(new Date().toISOString(), trade.id).run();

        // Create position record
        await createPosition(env, trade, result);

        // Update agent budget
        await updateAgentBudget(env, trade.agent_id, trade.total);

        succeeded++;
      } else {
        // Mark as failed
        await env.TRADER_DB.prepare(`
          UPDATE trades
          SET status = 'failed', error_message = ?
          WHERE id = ?
        `).bind(result.error || 'Unknown error', trade.id).run();

        failed++;
      }
    } catch (error) {
      await env.TRADER_DB.prepare(`
        UPDATE trades
        SET status = 'failed', error_message = ?
        WHERE id = ?
      `).bind(String(error), trade.id).run();

      failed++;
    }
  }

  return {
    trades_dispatched: pending.results.length,
    trades_succeeded: succeeded,
    trades_failed: failed,
  };
}
```

## 8. Call mgmt-api

```typescript
interface MgmtApiRequest {
  ticker: string;
  action: 'buy' | 'sell';
  quantity: number;
  dry_run: boolean;
}

interface MgmtApiResponse {
  success: boolean;
  order_id?: string;
  executed_price?: number;
  error?: string;
}

async function callMgmtApi(
  env: Env,
  request: MgmtApiRequest
): Promise<MgmtApiResponse> {
  const response = await fetch(`${env.MGMT_API_URL}/fidelity/execute-trade`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': env.MGMT_API_KEY,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    return {
      success: false,
      error: `HTTP ${response.status}: ${await response.text()}`,
    };
  }

  return response.json();
}
```

## 9. Create Position on Success

```typescript
async function createPosition(
  env: Env,
  trade: any,
  result: MgmtApiResponse
): Promise<void> {
  const now = new Date().toISOString();
  const price = result.executed_price || trade.price;

  await env.TRADER_DB.prepare(`
    INSERT INTO positions (
      id, agent_id, ticker, shares, entry_price, entry_date,
      cost_basis, highest_price, asset_type, status, signal_id,
      partial_sold, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stock', 'open', ?, 0, ?)
  `).bind(
    generateId('pos'),
    trade.agent_id,
    trade.ticker,
    trade.quantity,
    price,
    now.split('T')[0],
    trade.quantity * price,
    price,
    trade.signal_id,
    now
  ).run();
}
```

## 10. Update Agent Budget

```typescript
async function updateAgentBudget(
  env: Env,
  agentId: string,
  amount: number
): Promise<void> {
  const month = new Date().toISOString().slice(0, 7); // "2026-01"

  await env.TRADER_DB.prepare(`
    UPDATE agent_budgets
    SET spent = spent + ?
    WHERE agent_id = ? AND month = ?
  `).bind(amount, agentId, month).run();
}
```

---

## Environment Variables

```toml
# wrangler.toml
[vars]
SCRAPER_URL = "https://hadoku-scraper.workers.dev"

# Secrets (set via: wrangler secret put SECRET_NAME)
# SCRAPER_API_KEY   - API key for hadoku-scraper
# MGMT_API_URL      - URL to mgmt-api (e.g., https://mgmt.hadoku.com)
# MGMT_API_KEY      - API key for mgmt-api
```

---

## mgmt-api Endpoint

mgmt-api needs to expose an endpoint that forwards to fidelity-api:

```typescript
// POST /fidelity/execute-trade
app.post('/fidelity/execute-trade', async (req, res) => {
  const response = await fetch(`${FIDELITY_TUNNEL_URL}/execute-trade`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': FIDELITY_API_KEY,
    },
    body: JSON.stringify(req.body),
  });

  const result = await response.json();
  res.json(result);
});
```

---

## Testing Checklist

1. **Dry run first**: Set `dry_run: true` in `callMgmtApi` to test without executing real trades
2. **Check D1 tables**: Verify trades appear with `status='pending'` then `status='executed'`
3. **Verify positions**: Check positions table has new entries after successful trades
4. **Budget tracking**: Verify agent_budgets.spent is updated correctly
5. **Error handling**: Test with invalid tickers to verify error logging works

---

## Data Flow Summary

| Step | Component | Input | Output |
|------|-----------|-------|--------|
| 1 | hadoku-scraper | - | signals with current_price |
| 2 | enrichSignals() | ScraperSignal[] | EnrichedSignal[] |
| 3 | analyzeSignals() | EnrichedSignal[] | TradeAction[] |
| 4 | queueTrades() | TradeAction[] | trades in D1 |
| 5 | dispatchPendingTrades() | pending trades | executed/failed trades |
| 6 | mgmt-api | trade request | fidelity result |
| 7 | fidelity-api | trade request | order confirmation |
