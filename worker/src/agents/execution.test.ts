/**
 * Tests for the trade execution engine
 * Run with: npx vitest run execution.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EnrichedSignal, AgentDecision, AssetType } from './types'
import { CHATGPT_CONFIG, CLAUDE_CONFIG } from './configs'

// Mock the loader module
vi.mock('./loader', () => ({
  updateAgentBudget: vi.fn().mockResolvedValue(undefined)
}))

// Import after mocking
import {
  executeTrade,
  createPosition,
  updateTradeExecution,
  getPendingTradeId,
  callFidelityApi,
  executeSellOrder
} from './execution'
import { updateAgentBudget } from './loader'

// Helper to create mock environment
function createMockEnv(
  overrides: {
    tunnelResponse?: { success: boolean; order_id?: string; error?: string }
    dbResults?: Record<string, any>
  } = {}
) {
  const { tunnelResponse = { success: true, order_id: 'ORD123' } } = overrides

  // Mock fetch for Fidelity API
  global.fetch = vi.fn().mockResolvedValue({
    ok: tunnelResponse.success,
    status: tunnelResponse.success ? 200 : 500,
    json: vi.fn().mockResolvedValue(tunnelResponse),
    text: vi.fn().mockResolvedValue(tunnelResponse.error ?? '')
  })

  return {
    TRADER_DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          first: vi.fn().mockResolvedValue(overrides.dbResults?.first ?? null)
        }),
        // Support direct first() without bind() - used by getDefaultAccount
        first: vi.fn().mockResolvedValue(overrides.dbResults?.config ?? null)
      })
    },
    TUNNEL_URL: 'https://tunnel.example.com',
    TRADER_API_KEY: 'test-api-key',
    SCRAPER_API_KEY: 'scraper-key',
    SCRAPER_URL: 'https://scraper.example.com',
    ADMIN_KEYS: '["test-admin-key"]'
  } as any
}

// Helper to create test signal
function createTestSignal(overrides: Partial<EnrichedSignal> = {}): EnrichedSignal {
  return {
    id: 'signal_123',
    ticker: 'AAPL',
    action: 'buy',
    asset_type: 'stock',
    trade_price: 150,
    disclosure_price: 152,
    current_price: 155,
    trade_date: '2026-01-01',
    disclosure_date: '2026-01-05',
    position_size_min: 50000,
    politician_name: 'Nancy Pelosi',
    source: 'quiver_quant',
    days_since_trade: 10,
    days_since_filing: 6,
    price_change_pct: 3.33, // (155 - 150) / 150 * 100
    disclosure_drift_pct: 1.97, // (155 - 152) / 152 * 100
    ...overrides
  }
}

// Helper to create test decision
function createTestDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    agent_id: 'chatgpt',
    signal_id: 'signal_123',
    action: 'execute',
    decision_reason: 'execute',
    score: 0.85,
    score_breakdown: { time_decay: 0.9, price_movement: 0.8 },
    position_size: 150,
    ...overrides
  }
}

describe('Trade Execution Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('executeTrade', () => {
    it('should execute trade successfully', async () => {
      const env = createMockEnv({ tunnelResponse: { success: true, order_id: 'ORD456' } })
      const signal = createTestSignal({ current_price: 100 })
      const decision = createTestDecision()
      const positionSize = 200

      const result = await executeTrade(
        env,
        CHATGPT_CONFIG,
        signal,
        decision,
        positionSize,
        'trade_123'
      )

      expect(result.success).toBe(true)
      expect(result.trade_id).toBe('trade_123')
      expect(result.position_id).toBeTruthy()
      expect(result.shares).toBe(2) // $200 / $100 = 2 shares
      expect(result.executed_price).toBe(100)
      expect(result.total).toBe(200)
      expect(result.order_id).toBe('ORD456')
      expect(result.error).toBeNull()
    })

    it('should return 0 shares when position size too small for fractional', async () => {
      const env = createMockEnv()
      const signal = createTestSignal({ current_price: 500 }) // Expensive stock
      const decision = createTestDecision()
      const positionSize = 0.01 // Position size so small even fractional shares round to 0

      const result = await executeTrade(
        env,
        CHATGPT_CONFIG,
        signal,
        decision,
        positionSize,
        'trade_123'
      )

      // With fractional shares: $0.01 / $500 = 0.00002 shares → rounds to 0
      expect(result.success).toBe(false)
      expect(result.shares).toBe(0)
      expect(result.error).toBe('Insufficient funds for 1 share')
    })

    it('should handle API failure', async () => {
      const env = createMockEnv({
        tunnelResponse: { success: false, error: 'Connection refused' }
      })
      const signal = createTestSignal({ current_price: 100 })
      const decision = createTestDecision()

      const result = await executeTrade(env, CHATGPT_CONFIG, signal, decision, 200, 'trade_123')

      expect(result.success).toBe(false)
      // Error format is "API returned {status}: {error}" from callFidelityApi
      expect(result.error).toBe('API returned 500: Connection refused')
      expect(result.position_id).toBeNull()
    })

    it('should update budget after successful execution', async () => {
      const env = createMockEnv()
      const signal = createTestSignal({ current_price: 50 })

      await executeTrade(env, CHATGPT_CONFIG, signal, createTestDecision(), 100, 'trade_123')

      expect(updateAgentBudget).toHaveBeenCalledWith(env, 'chatgpt', 100)
    })
  })

  describe('createPosition', () => {
    it('should create position with correct fields', async () => {
      const env = createMockEnv()
      let capturedBindArgs: any[] = []

      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn((...args) => {
          capturedBindArgs = args
          return {
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
          }
        })
      })

      const positionId = await createPosition(
        env,
        'chatgpt',
        'AAPL',
        10,
        150,
        'signal_123',
        'stock'
      )

      expect(positionId).toMatch(/^pos_/)
      expect(capturedBindArgs).toContain('chatgpt') // agent_id
      expect(capturedBindArgs).toContain('AAPL') // ticker
      expect(capturedBindArgs).toContain(10) // shares
      expect(capturedBindArgs).toContain(150) // entry_price
      expect(capturedBindArgs).toContain(1500) // cost_basis (10 × 150)
      expect(capturedBindArgs).toContain('stock') // asset_type
      expect(capturedBindArgs).toContain('signal_123') // signal_id
    })
  })

  describe('updateTradeExecution', () => {
    it('should update trade with execution details', async () => {
      const env = createMockEnv()
      let capturedBindArgs: any[] = []

      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn((...args) => {
          capturedBindArgs = args
          return {
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
          }
        })
      })

      await updateTradeExecution(env, 'trade_123', {
        quantity: 5,
        price: 100,
        total: 500,
        status: 'executed',
        executed_at: '2026-01-15T10:00:00Z'
      })

      expect(capturedBindArgs).toContain(5) // quantity
      expect(capturedBindArgs).toContain(100) // price
      expect(capturedBindArgs).toContain(500) // total
      expect(capturedBindArgs).toContain('executed') // status
      expect(capturedBindArgs).toContain('trade_123') // id
    })

    it('should include error message when provided', async () => {
      const env = createMockEnv()
      let capturedBindArgs: any[] = []

      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn((...args) => {
          capturedBindArgs = args
          return {
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
          }
        })
      })

      await updateTradeExecution(env, 'trade_123', {
        quantity: 0,
        price: 100,
        total: 0,
        status: 'failed',
        executed_at: '2026-01-15T10:00:00Z',
        error_message: 'API timeout'
      })

      expect(capturedBindArgs).toContain('failed') // status
      expect(capturedBindArgs).toContain('API timeout') // error_message
    })
  })

  describe('getPendingTradeId', () => {
    it('should return trade ID when found', async () => {
      const env = createMockEnv({
        dbResults: { first: { id: 'trade_456' } }
      })

      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: 'trade_456' })
        })
      })

      const tradeId = await getPendingTradeId(env, 'chatgpt', 'signal_123')
      expect(tradeId).toBe('trade_456')
    })

    it('should return null when not found', async () => {
      const env = createMockEnv()

      env.TRADER_DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null)
        })
      })

      const tradeId = await getPendingTradeId(env, 'chatgpt', 'signal_999')
      expect(tradeId).toBeNull()
    })
  })

  describe('callFidelityApi', () => {
    it('should call API with correct parameters', async () => {
      const env = createMockEnv()

      await callFidelityApi(env, {
        ticker: 'AAPL',
        quantity: 10,
        action: 'buy',
        account: '12345'
      })

      expect(global.fetch).toHaveBeenCalledWith('https://tunnel.example.com/execute-trade', {
        method: 'POST',
        headers: {
          'X-User-Key': 'test-admin-key',
          'X-API-Key': 'test-api-key',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ticker: 'AAPL',
          quantity: 10,
          action: 'buy',
          account: '12345'
        })
      })
    })

    it('should return success response', async () => {
      const env = createMockEnv({
        tunnelResponse: { success: true, order_id: 'ORD789' }
      })

      const result = await callFidelityApi(env, {
        ticker: 'AAPL',
        quantity: 5,
        action: 'buy'
      })

      expect(result.success).toBe(true)
      expect(result.order_id).toBe('ORD789')
    })

    it('should handle network error', async () => {
      const env = createMockEnv()
      global.fetch = vi.fn().mockRejectedValue(new Error('Network timeout'))

      const result = await callFidelityApi(env, {
        ticker: 'AAPL',
        quantity: 5,
        action: 'buy'
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Network timeout')
    })

    it('should handle non-OK response', async () => {
      const env = createMockEnv()
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Internal Server Error')
      })

      const result = await callFidelityApi(env, {
        ticker: 'AAPL',
        quantity: 5,
        action: 'buy'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('500')
    })
  })

  describe('executeSellOrder', () => {
    it('should execute sell and credit budget', async () => {
      const env = createMockEnv({
        tunnelResponse: { success: true, order_id: 'SELL123' }
      })

      const result = await executeSellOrder(env, 'chatgpt', 'AAPL', 10, 160, 'stop_loss')

      expect(result.success).toBe(true)
      expect(result.order_id).toBe('SELL123')
      expect(result.total).toBe(1600) // 10 × 160
      // Budget should be credited (negative spend)
      expect(updateAgentBudget).toHaveBeenCalledWith(env, 'chatgpt', -1600)
    })

    it('should handle sell failure', async () => {
      const env = createMockEnv({
        tunnelResponse: { success: false, error: 'Market closed' }
      })

      const result = await executeSellOrder(env, 'chatgpt', 'AAPL', 10, 160, 'stop_loss')

      expect(result.success).toBe(false)
      // Error format is "API returned {status}: {error}" from callFidelityApi
      expect(result.error).toBe('API returned 500: Market closed')
      // Budget should NOT be credited on failure
      expect(updateAgentBudget).not.toHaveBeenCalled()
    })
  })
})
