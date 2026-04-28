/**
 * Tests for HTTP route handlers in routes.ts.
 *
 * Focused on the trades projection — covers the bug where skip rows
 * (executed_at IS NULL) were dropped from the LIMIT 100 window because
 * `ORDER BY executed_at DESC` sorts NULLs last, hiding shadow-trade
 * decisions made after a budget cap.
 */

import { describe, it, expect, vi } from 'vitest'
import { handleGetTrades } from './routes'
import type { TraderEnv } from './types'

interface DbRow {
  id: string
  signal_id: string | null
  agent_id: string | null
  ticker: string
  action: string
  decision: string | null
  score: number | null
  score_breakdown_json: string | null
  quantity: number
  price: number
  total: number
  status: string
  error_message: string | null
  reasoning_json: string | null
  executed_at: string | null
  created_at: string
}

function makeEnv(rows: DbRow[]): { env: TraderEnv; capturedSql: { sql: string } } {
  const captured = { sql: '' }
  const env = {
    TRADER_DB: {
      prepare: (sql: string) => {
        captured.sql = sql
        return {
          all: async () => ({ results: rows })
        }
      }
    }
  } as unknown as TraderEnv
  return { env, capturedSql: captured }
}

describe('handleGetTrades', () => {
  it('orders by COALESCE(executed_at, created_at) so skip rows are not evicted', async () => {
    const { env, capturedSql } = makeEnv([])
    await handleGetTrades(env)
    // The exact whitespace doesn't matter; we care that NULL-safe ordering
    // is in place. Without COALESCE, every skip row drops to the bottom and
    // gets cut by LIMIT 100 — which is how the Apr 18+ shadow trades went
    // invisible after the budget hit cap.
    expect(capturedSql).toMatchObject({
      sql: expect.stringContaining('COALESCE(executed_at, created_at)')
    })
    expect(capturedSql.sql).toContain('ORDER BY')
    expect(capturedSql.sql).toContain('DESC')
  })

  it('projects the full decision audit trail for each row', async () => {
    const skipRow: DbRow = {
      id: 'trade_1',
      signal_id: 'sig_1',
      agent_id: 'chatgpt',
      ticker: 'AAPL',
      action: 'buy',
      decision: 'skip_size_zero',
      score: 0.74,
      score_breakdown_json: JSON.stringify({ momentum: 0.4, conviction: 0.34 }),
      quantity: 0,
      price: 0,
      total: 0,
      status: 'skipped',
      error_message: null,
      reasoning_json: JSON.stringify({
        mode: 'score_squared',
        score: 0.74,
        budget_basis: 1000,
        budget_remaining_at_eval: 0,
        raw_size: 109.52,
        half_size_applied: false,
        caps: { max_position_amount: 250, max_position_pct_limit: 250, budget_remaining: 0 },
        final_size: 0,
        bound_by: 'budget_remaining'
      }),
      executed_at: null,
      created_at: '2026-04-22T09:01:11Z'
    }
    const { env } = makeEnv([skipRow])
    const res = await handleGetTrades(env)
    const body = (await res.json()) as { trades: Record<string, unknown>[] }
    expect(body.trades).toHaveLength(1)
    const t = body.trades[0]
    expect(t).toMatchObject({
      id: 'trade_1',
      agent_id: 'chatgpt',
      signal_id: 'sig_1',
      ticker: 'AAPL',
      action: 'buy',
      decision: 'skip_size_zero',
      score: 0.74,
      quantity: 0,
      price: 0,
      total: 0,
      status: 'skipped',
      error_message: null,
      executed_at: null,
      created_at: '2026-04-22T09:01:11Z',
      // backwards-compat: existing dashboard reads `date`, which falls back to
      // created_at for skip rows so they sort sensibly in the UI.
      date: '2026-04-22T09:01:11Z'
    })
    expect(t.score_breakdown).toEqual({ momentum: 0.4, conviction: 0.34 })
    expect(t.reasoning).toMatchObject({
      mode: 'score_squared',
      bound_by: 'budget_remaining',
      budget_remaining_at_eval: 0,
      raw_size: 109.52,
      final_size: 0
    })
  })

  it('survives malformed JSON in reasoning_json / score_breakdown_json', async () => {
    const row: DbRow = {
      id: 'trade_bad',
      signal_id: 'sig_x',
      agent_id: 'chatgpt',
      ticker: 'XYZ',
      action: 'buy',
      decision: 'execute',
      score: null,
      score_breakdown_json: '{not json',
      quantity: 1,
      price: 10,
      total: 10,
      status: 'executed',
      error_message: null,
      reasoning_json: 'also not json',
      executed_at: '2026-04-15T00:00:00Z',
      created_at: '2026-04-15T00:00:00Z'
    }
    const { env } = makeEnv([row])
    const res = await handleGetTrades(env)
    const body = (await res.json()) as { trades: Record<string, unknown>[] }
    expect(body.trades[0]).toMatchObject({
      reasoning: null,
      score_breakdown: null
    })
  })

  it('uses executed_at for `date` when present', async () => {
    const row: DbRow = {
      id: 'trade_2',
      signal_id: 'sig_2',
      agent_id: 'chatgpt',
      ticker: 'NVDA',
      action: 'buy',
      decision: 'execute',
      score: 0.9,
      score_breakdown_json: null,
      quantity: 0.5,
      price: 200,
      total: 100,
      status: 'executed',
      error_message: null,
      reasoning_json: null,
      executed_at: '2026-04-17T02:00:20Z',
      created_at: '2026-04-17T02:00:00Z'
    }
    const { env } = makeEnv([row])
    const res = await handleGetTrades(env)
    const body = (await res.json()) as { trades: Record<string, unknown>[] }
    expect(body.trades[0]).toMatchObject({
      date: '2026-04-17T02:00:20Z',
      executed_at: '2026-04-17T02:00:20Z',
      created_at: '2026-04-17T02:00:00Z'
    })
  })
})

// silence unused import in environments where vi isn't used
void vi
