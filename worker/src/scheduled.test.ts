/**
 * Tests for scheduled.ts — runConcurrent and syncMarketPrices.
 *
 * runConcurrent tests are pure logic, no mocks.
 *
 * syncMarketPrices tests run against real infrastructure when env vars are set:
 *   SCRAPER_URL=https://... SCRAPER_API_KEY=xxx TRADER_DB=... pnpm test scheduled.test.ts
 *
 * Without env vars they run with mocked fetch and a mock D1, verifying
 * that batches are dispatched concurrently (not sequentially).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runConcurrent, syncMarketPrices } from './scheduled'
import type { TraderEnv } from './types'

// =============================================================================
// runConcurrent — pure logic, zero mocks
// =============================================================================

describe('runConcurrent', () => {
  it('runs all tasks and collects results', async () => {
    const tasks = [1, 2, 3].map(n => async () => n * 10)
    const results = await runConcurrent(tasks, 2)
    expect(results).toHaveLength(3)
    expect(results.sort((a, b) => a - b)).toEqual([10, 20, 30])
  })

  it('handles empty task list', async () => {
    const results = await runConcurrent([], 3)
    expect(results).toEqual([])
  })

  it('works when concurrency > task count', async () => {
    const tasks = [1, 2].map(n => async () => n)
    const results = await runConcurrent(tasks, 10)
    expect(results.sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('caps concurrency at the given limit', async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0
    const CONCURRENCY = 3
    const TASK_COUNT = 9

    const tasks = Array.from({ length: TASK_COUNT }, () => async () => {
      currentConcurrent++
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
      // Small async yield so other tasks can start before this one finishes
      await new Promise(r => setTimeout(r, 5))
      currentConcurrent--
      return true
    })

    await runConcurrent(tasks, CONCURRENCY)

    expect(maxConcurrent).toBeLessThanOrEqual(CONCURRENCY)
    expect(maxConcurrent).toBeGreaterThan(1) // Confirmed concurrency actually happened
  })

  it('concurrency=1 is effectively sequential (never >1 in flight)', async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0

    const tasks = Array.from({ length: 5 }, () => async () => {
      currentConcurrent++
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
      await new Promise(r => setTimeout(r, 5))
      currentConcurrent--
    })

    await runConcurrent(tasks, 1)
    expect(maxConcurrent).toBe(1)
  })

  it('propagates errors from individual tasks', async () => {
    const tasks = [
      async () => 'ok',
      async () => {
        throw new Error('boom')
      }
    ]
    await expect(runConcurrent(tasks, 2)).rejects.toThrow('boom')
  })
})

// =============================================================================
// syncMarketPrices — mocked fetch + mock D1
// (real infra when SCRAPER_URL + SCRAPER_API_KEY set)
// =============================================================================

const SCRAPER_URL = process.env.SCRAPER_URL
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY
const isLive = !!(SCRAPER_URL && SCRAPER_API_KEY)

function createMockD1(tickers: string[] = ['NVDA', 'AAPL', 'MSFT']) {
  const latestDates: Record<string, string> = {}

  return {
    prepare(sql: string) {
      let boundParams: unknown[] = []
      return {
        bind(...params: unknown[]) {
          boundParams = params
          return this
        },
        async run() {
          return { success: true, meta: { changes: 1 } }
        },
        async first() {
          return null
        },
        async all() {
          const upper = sql.trim().toUpperCase()
          // Ticker query (DISTINCT ticker FROM signals UNION positions)
          if (upper.includes('DISTINCT') && upper.includes('TICKER')) {
            return { results: tickers.map(t => ({ ticker: t })) }
          }
          // Latest date per ticker query
          if (upper.includes('MAX(DATE)') && upper.includes('GROUP BY')) {
            const rows = Object.entries(latestDates).map(([ticker, latest_date]) => ({
              ticker,
              latest_date
            }))
            return { results: rows }
          }
          return { results: [] }
        },
        async batch() {
          return []
        }
      }
    },
    batch(stmts: unknown[]) {
      void stmts
      return Promise.resolve([])
    }
  }
}

function createMockEnv(tickers?: string[]): TraderEnv {
  return {
    TRADER_DB: createMockD1(tickers) as unknown as TraderEnv['TRADER_DB'],
    TRADER_API_KEY: 'test-api-key',
    SCRAPER_API_KEY: isLive ? (SCRAPER_API_KEY as string) : 'mock-key',
    SCRAPER_URL: isLive ? (SCRAPER_URL as string) : 'https://mock-scraper',
    TUNNEL_URL: 'http://localhost:3001'
  } as TraderEnv
}

function mockMarketResponse(tickersInBatch: string[]) {
  return {
    success: true,
    data: {
      records: tickersInBatch.map(ticker => ({
        ticker,
        date: '2026-03-14',
        open: 100,
        high: 105,
        low: 99,
        close: 103,
        volume: 1_000_000
      })),
      record_count: tickersInBatch.length,
      ticker_count: tickersInBatch.length,
      start_date: '2026-02-12',
      end_date: '2026-03-14'
    }
  }
}

describe('syncMarketPrices', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('fetches prices for all new tickers (no prior data)', async () => {
    const tickers = ['NVDA', 'AAPL', 'MSFT']
    const env = createMockEnv(tickers)

    if (!isLive) {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockMarketResponse(tickers))
      })
    }

    // Should not throw
    await expect(syncMarketPrices(env)).resolves.not.toThrow()

    if (!isLive) {
      expect(globalThis.fetch).toHaveBeenCalled()
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(url).toContain('/api/v1/market/historical')
    }
  })

  it('dispatches multiple batches concurrently when there are many new tickers', async () => {
    // 250 new tickers = 3 batches of 100/100/50 (batchSize=100)
    const tickers = Array.from({ length: 250 }, (_, i) => `TICK${i.toString().padStart(3, '0')}`)
    const env = createMockEnv(tickers)

    if (isLive) {
      // Live mode: just verify no throw and at least one fetch succeeds
      await expect(syncMarketPrices(env)).resolves.not.toThrow()
      return
    }

    const callTimestamps: number[] = []
    let inFlight = 0
    let maxInFlight = 0

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      callTimestamps.push(Date.now())
      // Simulate ~20ms per fetch so batches overlap
      await new Promise(r => setTimeout(r, 20))
      inFlight--
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockMarketResponse(['MOCK']))
      }
    })

    await syncMarketPrices(env)

    // 250 tickers / 100 per batch = 3 batches
    expect(globalThis.fetch).toHaveBeenCalledTimes(3)
    // With concurrency=3 and 3 batches, all 3 should fire concurrently
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  it('handles scraper errors gracefully (does not throw)', async () => {
    const env = createMockEnv(['NVDA'])

    if (!isLive) {
      // Use 404 (not retried) so the test doesn't wait through backoff delays
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: () => Promise.resolve({ detail: 'Not found', request_id: 'req_test' }),
        text: () => Promise.resolve('Not found')
      })
    }

    await expect(syncMarketPrices(env)).resolves.not.toThrow()
  })

  it('skips sync when no tickers exist', async () => {
    const env = createMockEnv([]) // empty ticker list

    if (!isLive) {
      globalThis.fetch = vi.fn()
    }

    await syncMarketPrices(env)

    if (!isLive) {
      expect(globalThis.fetch).not.toHaveBeenCalled()
    }
  })
})
