/**
 * Tests that validate the scraper API response format.
 *
 * When env vars are set, these tests call the real scraper API:
 *   SCRAPER_URL=https://scraper.hadoku.me SCRAPER_API_KEY=xxx pnpm test scraper-api.test.ts
 *
 * When env vars are missing, tests run against a mock response to validate
 * the expected type structure still holds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { components } from './generated/scraper-api'

type ScraperSignalsResponse = components['schemas']['FetchSignalsResponse']

const SCRAPER_URL = process.env.SCRAPER_URL
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY
const isLive = !!(SCRAPER_URL && SCRAPER_API_KEY)

const MOCK_RESPONSE: ScraperSignalsResponse = {
  signals: [
    {
      source: 'capitol_trades',
      politician: { name: 'Nancy Pelosi', chamber: 'house', party: 'D', state: 'CA' },
      trade: {
        ticker: 'NVDA',
        action: 'buy',
        asset_type: 'stock',
        trade_date: '2026-01-15',
        trade_price: 130,
        disclosure_date: '2026-02-01',
        disclosure_price: 135,
        position_size: '$1,001 - $15,000',
        position_size_min: 1001,
        position_size_max: 15000,
        option_type: null,
        strike_price: null,
        expiration_date: null
      },
      meta: {
        source_url: 'https://example.com',
        source_id: 'ct_mock_1',
        scraped_at: '2026-02-01T00:00:00Z'
      }
    }
  ],
  sources_fetched: ['capitol_trades'],
  sources_failed: {},
  total_signals: 1,
  fetched_at: '2026-02-01T00:00:00Z'
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  if (!isLive) {
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(MOCK_RESPONSE)
    })
  }
})

afterEach(() => {
  if (!isLive) {
    globalThis.fetch = originalFetch
  }
})

function buildUrl(path: string): string {
  return isLive ? `${SCRAPER_URL}${path}` : `https://mock-scraper${path}`
}

function buildHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${isLive ? SCRAPER_API_KEY : 'mock-key'}`,
    Accept: 'application/json'
  }
}

describe('Scraper API Integration', () => {
  it('GET /api/v1/politrades/signals returns expected format', async () => {
    const resp = await fetch(`${buildUrl('/api/v1/politrades/signals')}?limit=5`, {
      headers: buildHeaders()
    })

    expect(resp.ok).toBe(true)
    expect(resp.status).toBe(200)

    const data: ScraperSignalsResponse = await resp.json()

    // Validate top-level structure
    expect(data).toHaveProperty('signals')
    expect(data).toHaveProperty('sources_fetched')
    expect(data).toHaveProperty('sources_failed')
    expect(data).toHaveProperty('total_signals')
    expect(data).toHaveProperty('fetched_at')

    // Validate types
    expect(Array.isArray(data.signals)).toBe(true)
    expect(Array.isArray(data.sources_fetched)).toBe(true)
    expect(typeof data.sources_failed).toBe('object')
    expect(typeof data.total_signals).toBe('number')
    expect(typeof data.fetched_at).toBe('string')

    // Validate signal count matches
    expect(data.signals.length).toBeLessThanOrEqual(5)
    expect(data.total_signals).toBe(data.signals.length)

    // Validate signal structure if we have any
    if (data.signals.length > 0) {
      const signal = data.signals[0]

      // Required top-level fields
      expect(signal).toHaveProperty('source')
      expect(signal).toHaveProperty('politician')
      expect(signal).toHaveProperty('trade')
      expect(signal).toHaveProperty('meta')

      // Politician fields
      expect(signal.politician).toHaveProperty('name')
      expect(signal.politician).toHaveProperty('chamber')
      expect(signal.politician).toHaveProperty('party')
      expect(signal.politician).toHaveProperty('state')

      // Trade fields
      expect(signal.trade).toHaveProperty('action')
      expect(signal.trade).toHaveProperty('trade_date')
      expect(signal.trade).toHaveProperty('disclosure_date')

      // Meta fields
      expect(signal.meta).toHaveProperty('source_id')
      expect(signal.meta).toHaveProperty('scraped_at')
    }

    console.log(
      `✓ Validated ${data.total_signals} signals from ${data.sources_fetched.join(', ')}${isLive ? '' : ' (mocked)'}`
    )
  })

  it('should NOT have legacy fields (success, data, count)', async () => {
    const resp = await fetch(`${buildUrl('/api/v1/politrades/signals')}?limit=1`, {
      headers: buildHeaders()
    })

    const data = await resp.json()

    // These are the WRONG fields that trader-worker v1.5.0-1.6.1 incorrectly expected
    expect(data).not.toHaveProperty('success')
    expect(data).not.toHaveProperty('data')
    expect(data).not.toHaveProperty('count')

    // These are the CORRECT fields
    expect(data).toHaveProperty('signals')
    expect(data).toHaveProperty('total_signals')
  })
})
