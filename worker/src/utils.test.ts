/**
 * Unit tests for utility functions.
 */

import { describe, it, expect } from 'vitest'
import { validatePrices, calculateDisclosureLagDays } from './utils'

describe('validatePrices', () => {
  it('accepts valid trade price with valid disclosure price', () => {
    const result = validatePrices(100.5, 105.25)
    expect(result.valid).toBe(true)
    expect(result.trade_price).toBe(100.5)
    expect(result.disclosure_price).toBe(105.25)
  })

  it('accepts valid trade price with null disclosure price', () => {
    const result = validatePrices(50.0, null)
    expect(result.valid).toBe(true)
    expect(result.trade_price).toBe(50.0)
    expect(result.disclosure_price).toBeNull()
  })

  it('accepts valid trade price with undefined disclosure price', () => {
    const result = validatePrices(50.0, undefined)
    expect(result.valid).toBe(true)
    expect(result.trade_price).toBe(50.0)
    expect(result.disclosure_price).toBeNull()
  })

  it('rejects null trade price', () => {
    const result = validatePrices(null, 100)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('trade_price is required')
  })

  it('rejects undefined trade price', () => {
    const result = validatePrices(undefined, 100)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('trade_price is required')
  })

  it('rejects zero trade price', () => {
    const result = validatePrices(0, 100)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('must be positive')
  })

  it('rejects negative trade price', () => {
    const result = validatePrices(-5.5, 100)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('must be positive')
  })

  it('rejects absurdly high trade price', () => {
    const result = validatePrices(2000000, 100)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('seems invalid')
  })

  it('converts zero disclosure price to null', () => {
    const result = validatePrices(100, 0)
    expect(result.valid).toBe(true)
    expect(result.disclosure_price).toBeNull()
  })

  it('converts negative disclosure price to null', () => {
    const result = validatePrices(100, -10)
    expect(result.valid).toBe(true)
    expect(result.disclosure_price).toBeNull()
  })

  it('accepts high but valid stock prices (e.g., BRK.A-like)', () => {
    // BRK.A trades at ~$600k, allow up to $1M
    const result = validatePrices(650000, 655000)
    expect(result.valid).toBe(true)
    expect(result.trade_price).toBe(650000)
  })
})

describe('calculateDisclosureLagDays', () => {
  it('calculates lag correctly for same-day disclosure', () => {
    expect(calculateDisclosureLagDays('2026-01-15', '2026-01-15')).toBe(0)
  })

  it('calculates lag correctly for 30-day disclosure', () => {
    expect(calculateDisclosureLagDays('2026-01-01', '2026-01-31')).toBe(30)
  })

  it('returns null for missing trade date', () => {
    expect(calculateDisclosureLagDays(null, '2026-01-15')).toBeNull()
  })

  it('returns null for missing disclosure date', () => {
    expect(calculateDisclosureLagDays('2026-01-15', null)).toBeNull()
  })

  it('returns null for both dates missing', () => {
    expect(calculateDisclosureLagDays(undefined, undefined)).toBeNull()
  })
})
