/**
 * Tests for the scoring engine
 * Run with: npx vitest run scoring.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EnrichedSignal, ScoringConfig } from './types'
import { CHATGPT_CONFIG, CLAUDE_CONFIG } from './configs'

// Mock the loader module
vi.mock('./loader', () => ({
  getPoliticianStats: vi.fn()
}))

// Import after mocking
import { calculateScore, getSignalConfirmationCount } from './scoring'
import { getPoliticianStats } from './loader'

// Mock TraderEnv
const mockEnv = {
  TRADER_DB: {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ count: 1 })
      })
    })
  }
} as any

// Helper to create a test signal
function createTestSignal(overrides: Partial<EnrichedSignal> = {}): EnrichedSignal {
  return {
    id: 'test_signal_1',
    ticker: 'AAPL',
    action: 'buy',
    asset_type: 'stock',
    trade_price: 100,
    current_price: 100,
    trade_date: '2026-01-01',
    disclosure_date: '2026-01-05',
    position_size_min: 50000,
    politician_name: 'Nancy Pelosi',
    source: 'quiver_quant',
    days_since_trade: 10,
    days_since_filing: 6,
    price_change_pct: 0, // 0%
    ...overrides
  }
}

describe('Scoring Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default mock for politician stats - no data
    ;(getPoliticianStats as any).mockResolvedValue(null)
    // Default mock for confirmation count - 1 source
    mockEnv.TRADER_DB.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ count: 1 })
      })
    })
  })

  describe('Time Decay', () => {
    it('should return 1.0 at day 0', async () => {
      const signal = createTestSignal({ days_since_trade: 0 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.time_decay).toBeCloseTo(1.0, 2)
    })

    it('should return 0.5 at half-life (10 days for ChatGPT)', async () => {
      const signal = createTestSignal({ days_since_trade: 10 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.time_decay).toBeCloseTo(0.5, 2)
    })

    it('should return 0.25 at 2x half-life (20 days for ChatGPT)', async () => {
      const signal = createTestSignal({ days_since_trade: 20 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.time_decay).toBeCloseTo(0.25, 2)
    })

    it('Claude should use filing date decay and take minimum', async () => {
      // Claude: trade half-life 14 days, filing half-life 3 days
      // At 6 days since filing: filing decay = 0.5^(6/3) = 0.25
      // At 10 days since trade: trade decay = 0.5^(10/14) ≈ 0.61
      // Should take minimum: 0.25
      const signal = createTestSignal({
        days_since_trade: 10,
        days_since_filing: 6
      })
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)
      expect(result.breakdown.time_decay).toBeCloseTo(0.25, 2)
    })
  })

  describe('Price Movement', () => {
    it('should return 1.0 (pct_0) at 0% price change for ChatGPT', async () => {
      const signal = createTestSignal({ price_change_pct: 0 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.price_movement).toBeCloseTo(1.0, 2)
    })

    it('should return 0.8 (pct_5) at 5% price change for ChatGPT', async () => {
      const signal = createTestSignal({ price_change_pct: 5 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.price_movement).toBeCloseTo(0.8, 2)
    })

    it('should interpolate between 0% and 5% for ChatGPT', async () => {
      const signal = createTestSignal({ price_change_pct: 2.5 }) // 2.5%
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      // lerp(1.0, 0.8, 0.5) = 0.9
      expect(result.breakdown.price_movement).toBeCloseTo(0.9, 2)
    })

    it('should return 0.4 (pct_15) at 15% price change for ChatGPT', async () => {
      const signal = createTestSignal({ price_change_pct: 15 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.price_movement).toBeCloseTo(0.4, 2)
    })

    it('should return 0 at 25% price change for ChatGPT', async () => {
      const signal = createTestSignal({ price_change_pct: 25 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.price_movement).toBeCloseTo(0.0, 2)
    })

    it('should return 0 beyond 25% price change', async () => {
      const signal = createTestSignal({ price_change_pct: 30 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.price_movement).toBeCloseTo(0.0, 2)
    })

    it('should apply 1.2x dip bonus for buy signals with negative price change', async () => {
      const signal = createTestSignal({
        action: 'buy',
        price_change_pct: -5 // 5% drop
      })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      // At 5% move: base score = 0.8, with 1.2x bonus = 0.96
      expect(result.breakdown.price_movement).toBeCloseTo(0.96, 2)
    })

    it('should NOT apply dip bonus for sell signals', async () => {
      const signal = createTestSignal({
        action: 'sell',
        price_change_pct: -5
      })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.price_movement).toBeCloseTo(0.8, 2)
    })

    it('should cap dip bonus at 1.2', async () => {
      // Claude has pct_0 = 1.2, so with dip bonus would be 1.44, but should cap at 1.2
      const signal = createTestSignal({
        action: 'buy',
        price_change_pct: -0.1 // tiny dip
      })
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)
      expect(result.breakdown.price_movement).toBeLessThanOrEqual(1.2)
    })
  })

  describe('Position Size', () => {
    it('should return lowest score for small positions (ChatGPT)', async () => {
      // ChatGPT thresholds: [15000, 50000, 100000, 250000], scores: [0.2, 0.4, 0.6, 0.8, 1.0]
      const signal = createTestSignal({ position_size_min: 10000 }) // Below $15k
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.position_size).toBeCloseTo(0.2, 2)
    })

    it('should return correct score at $50k threshold (ChatGPT)', async () => {
      const signal = createTestSignal({ position_size_min: 50000 })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.position_size).toBeCloseTo(0.6, 2) // idx=2 -> scores[2]=0.6
    })

    it('should return highest score for large positions (ChatGPT)', async () => {
      const signal = createTestSignal({ position_size_min: 500000 }) // $500k
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.position_size).toBeCloseTo(1.0, 2)
    })
  })

  describe('Politician Skill', () => {
    it('should return default score when no stats available', async () => {
      ;(getPoliticianStats as any).mockResolvedValue(null)
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.politician_skill).toBeCloseTo(0.5, 2)
    })

    it('should return default score when insufficient trades', async () => {
      ;(getPoliticianStats as any).mockResolvedValue({
        total_trades: 10, // Less than min_trades_for_data (20)
        winning_trades: 8,
        win_rate: 0.8
      })
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.politician_skill).toBeCloseTo(0.5, 2)
    })

    it('should use win_rate when sufficient trades and clamp to [0.4, 0.7]', async () => {
      ;(getPoliticianStats as any).mockResolvedValue({
        total_trades: 50,
        winning_trades: 30,
        win_rate: 0.6 // 60% win rate
      })
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.politician_skill).toBeCloseTo(0.6, 2)
    })

    it('should clamp high win_rate to 0.7', async () => {
      ;(getPoliticianStats as any).mockResolvedValue({
        total_trades: 50,
        winning_trades: 45,
        win_rate: 0.9 // 90% should clamp to 70%
      })
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.politician_skill).toBeCloseTo(0.7, 2)
    })

    it('should clamp low win_rate to 0.4', async () => {
      ;(getPoliticianStats as any).mockResolvedValue({
        total_trades: 50,
        winning_trades: 10,
        win_rate: 0.2 // 20% should clamp to 40%
      })
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.politician_skill).toBeCloseTo(0.4, 2)
    })
  })

  describe('Source Quality', () => {
    it('should return correct score for known source (quiver_quant)', async () => {
      const signal = createTestSignal({ source: 'quiver_quant' })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.source_quality).toBeCloseTo(1.0, 2)
    })

    it('should return correct score for capitol_trades', async () => {
      const signal = createTestSignal({ source: 'capitol_trades' })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.source_quality).toBeCloseTo(0.9, 2)
    })

    it('should return default score for unknown source', async () => {
      const signal = createTestSignal({ source: 'unknown_source' })
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.source_quality).toBeCloseTo(0.8, 2)
    })

    it('should add confirmation bonus for multiple sources', async () => {
      // Mock 3 sources
      mockEnv.TRADER_DB.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 3 })
        })
      })

      const signal = createTestSignal({ source: 'quiver_quant' }) // base 1.0
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      // 1.0 + (3-1) * 0.05 = 1.0 + 0.10 = 1.10
      expect(result.breakdown.source_quality).toBeCloseTo(1.1, 2)
    })

    it('should cap confirmation bonus at max_confirmation_bonus', async () => {
      // Mock 10 sources
      mockEnv.TRADER_DB.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 10 })
        })
      })

      const signal = createTestSignal({ source: 'quiver_quant' }) // base 1.0
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      // 1.0 + min((10-1)*0.05, 0.15) = 1.0 + 0.15 = 1.15
      expect(result.breakdown.source_quality).toBeCloseTo(1.15, 2)
    })
  })

  describe('Filing Speed (Claude only)', () => {
    it('should apply fast bonus for recent filings (<=7 days)', async () => {
      const signal = createTestSignal({ days_since_filing: 5 })
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)
      // 1.0 + 0.05 = 1.05
      expect(result.breakdown.filing_speed).toBeCloseTo(1.05, 2)
    })

    it('should return 1.0 for normal filing speed (8-29 days)', async () => {
      const signal = createTestSignal({ days_since_filing: 15 })
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)
      expect(result.breakdown.filing_speed).toBeCloseTo(1.0, 2)
    })

    it('should apply slow penalty for old filings (>=30 days)', async () => {
      const signal = createTestSignal({ days_since_filing: 35 })
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)
      // 1.0 + (-0.1) = 0.9
      expect(result.breakdown.filing_speed).toBeCloseTo(0.9, 2)
    })

    it('should NOT have filing_speed for ChatGPT', async () => {
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.filing_speed).toBeUndefined()
    })
  })

  describe('Cross Confirmation (Claude only)', () => {
    it('should return 1.0 for single source', async () => {
      mockEnv.TRADER_DB.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 1 })
        })
      })

      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)
      expect(result.breakdown.cross_confirmation).toBeCloseTo(1.0, 2)
    })

    it('should add bonus for multiple sources', async () => {
      mockEnv.TRADER_DB.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 3 })
        })
      })

      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)
      // 1.0 + (3-1) * 0.05 = 1.0 + 0.10 = 1.10
      expect(result.breakdown.cross_confirmation).toBeCloseTo(1.1, 2)
    })

    it('should cap bonus at max_bonus', async () => {
      mockEnv.TRADER_DB.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ count: 10 })
        })
      })

      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)
      // 1.0 + min((10-1)*0.05, 0.15) = 1.0 + 0.15 = 1.15
      expect(result.breakdown.cross_confirmation).toBeCloseTo(1.15, 2)
    })

    it('should NOT have cross_confirmation for ChatGPT', async () => {
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.breakdown.cross_confirmation).toBeUndefined()
    })
  })

  describe('Final Score Calculation', () => {
    it('should calculate weighted average correctly', async () => {
      // Create a signal where we know the expected component scores
      const signal = createTestSignal({
        days_since_trade: 0, // time_decay = 1.0
        price_change_pct: 0, // price_movement = 1.0
        position_size_min: 250000, // position_size = 1.0
        source: 'quiver_quant' // source_quality = 1.0
      })

      // ChatGPT weights: time_decay=0.3, price_movement=0.25, position_size=0.15,
      //                  politician_skill=0.2, source_quality=0.1
      // If all components = 1.0 except politician_skill = 0.5 (default)
      // weighted = (1*0.3 + 1*0.25 + 1*0.15 + 0.5*0.2 + 1*0.1) = 0.3 + 0.25 + 0.15 + 0.1 + 0.1 = 0.9
      // total_weight = 0.3 + 0.25 + 0.15 + 0.2 + 0.1 = 1.0
      // final = 0.9 / 1.0 = 0.9

      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.score).toBeCloseTo(0.9, 1)
    })

    it('should clamp final score to [0, 1]', async () => {
      // Even if components return > 1 (like dip bonus), final should be clamped
      const signal = createTestSignal({
        days_since_trade: 0,
        price_change_pct: -0.1, // Tiny dip with bonus
        position_size_min: 500000,
        source: 'quiver_quant'
      })

      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)
      expect(result.score).toBeLessThanOrEqual(1)
      expect(result.score).toBeGreaterThanOrEqual(0)
    })

    it('ChatGPT should have 5 components in breakdown', async () => {
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CHATGPT_CONFIG.scoring!, signal)

      expect(result.breakdown).toHaveProperty('time_decay')
      expect(result.breakdown).toHaveProperty('price_movement')
      expect(result.breakdown).toHaveProperty('position_size')
      expect(result.breakdown).toHaveProperty('politician_skill')
      expect(result.breakdown).toHaveProperty('source_quality')
      expect(result.breakdown).not.toHaveProperty('filing_speed')
      expect(result.breakdown).not.toHaveProperty('cross_confirmation')
    })

    it('Claude should have 6 components in breakdown (no source_quality)', async () => {
      const signal = createTestSignal()
      const result = await calculateScore(mockEnv, CLAUDE_CONFIG.scoring!, signal)

      expect(result.breakdown).toHaveProperty('time_decay')
      expect(result.breakdown).toHaveProperty('price_movement')
      expect(result.breakdown).toHaveProperty('position_size')
      expect(result.breakdown).toHaveProperty('politician_skill')
      expect(result.breakdown).toHaveProperty('filing_speed')
      expect(result.breakdown).toHaveProperty('cross_confirmation')
      expect(result.breakdown).not.toHaveProperty('source_quality')
    })
  })
})
