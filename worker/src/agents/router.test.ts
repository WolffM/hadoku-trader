import { describe, it, expect } from 'vitest'
import { summarizeDecisions } from './router'
import type { AgentDecision } from './types'

function decision(overrides: Partial<AgentDecision>): AgentDecision {
  return {
    agent_id: 'chatgpt',
    signal_id: 'sig_1',
    action: 'skip',
    decision_reason: 'skip_low_score',
    score: null,
    score_breakdown: null,
    position_size: null,
    ...overrides
  }
}

describe('summarizeDecisions', () => {
  it('returns skip + no_active_agents when no decisions', () => {
    expect(summarizeDecisions([])).toEqual({
      executionDecision: 'skip',
      skipReason: 'no_active_agents'
    })
  })

  it('returns execute with null reason when any agent executed', () => {
    const out = summarizeDecisions([
      decision({ action: 'skip', decision_reason: 'skip_low_score' }),
      decision({ agent_id: 'claude', action: 'execute', decision_reason: 'execute' })
    ])
    expect(out).toEqual({ executionDecision: 'execute', skipReason: null })
  })

  it('treats execute_half as executed', () => {
    const out = summarizeDecisions([
      decision({ action: 'execute_half', decision_reason: 'execute_half' })
    ])
    expect(out.executionDecision).toBe('execute')
    expect(out.skipReason).toBeNull()
  })

  it('joins per-agent reasons when all skip', () => {
    const out = summarizeDecisions([
      decision({ agent_id: 'chatgpt', decision_reason: 'skip_price_changed_too_much' }),
      decision({ agent_id: 'claude', decision_reason: 'skip_duplicate_position' })
    ])
    expect(out.executionDecision).toBe('skip')
    expect(out.skipReason).toBe(
      'chatgpt:skip_price_changed_too_much;claude:skip_duplicate_position'
    )
  })

  it('truncates long joined reasons at 500 chars', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      decision({ agent_id: `agent_${i}`, decision_reason: 'skip_low_score' })
    )
    const out = summarizeDecisions(many)
    expect(out.skipReason?.length).toBeLessThanOrEqual(500)
  })
})
