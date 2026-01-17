import { useState, useEffect } from 'react'
import type { AgentSummary, AgentPosition } from '../../types/api'
import { fetchAgents, fetchAgent } from '../../services/api'

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

interface AgentCardProps {
  agent: AgentSummary
  positions: AgentPosition[]
  isExpanded: boolean
  onToggle: () => void
  isLoading: boolean
}

function AgentCard({ agent, positions, isExpanded, onToggle, isLoading }: AgentCardProps) {
  const budgetPct = agent.monthly_budget > 0
    ? (agent.budget_spent / agent.monthly_budget) * 100
    : 0

  return (
    <div className="agent-card">
      <div className="agent-card__header" onClick={onToggle}>
        <div className="agent-card__info">
          <h3 className="agent-card__name">{agent.name}</h3>
          <span className="agent-card__positions">
            {agent.positions_count} position{agent.positions_count !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="agent-card__stats">
          <div className="agent-card__stat">
            <span className="agent-card__stat-label">Return</span>
            <span className={`agent-card__stat-value ${agent.total_return_pct >= 0 ? 'positive' : 'negative'}`}>
              {formatPercent(agent.total_return_pct)}
            </span>
          </div>

          <div className="agent-card__stat">
            <span className="agent-card__stat-label">Budget</span>
            <span className="agent-card__stat-value">
              {formatCurrency(agent.budget_remaining)} left
            </span>
          </div>
        </div>

        <span className="agent-card__expand">{isExpanded ? '−' : '+'}</span>
      </div>

      {/* Budget progress bar */}
      <div className="agent-card__budget-bar">
        <div
          className="agent-card__budget-fill"
          style={{ width: `${Math.min(budgetPct, 100)}%` }}
        />
      </div>

      {isExpanded && (
        <div className="agent-card__content">
          {isLoading ? (
            <div className="agent-card__loading">Loading positions...</div>
          ) : positions.length === 0 ? (
            <div className="agent-card__empty">No open positions</div>
          ) : (
            <table className="agent-card__table">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Shares</th>
                  <th>Entry</th>
                  <th>Current</th>
                  <th>P&L</th>
                  <th>Days</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(pos => (
                  <tr key={pos.ticker} className="agent-card__position-row">
                    <td className="agent-card__ticker">{pos.ticker}</td>
                    <td className="agent-card__shares">{pos.shares}</td>
                    <td className="agent-card__price">{formatCurrency(pos.entry_price)}</td>
                    <td className="agent-card__price">{formatCurrency(pos.current_price)}</td>
                    <td className={`agent-card__pnl ${pos.return_pct >= 0 ? 'positive' : 'negative'}`}>
                      {formatPercent(pos.return_pct)}
                    </td>
                    <td className="agent-card__days">{pos.days_held}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

export function AgentPositions() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [positions, setPositions] = useState<Record<string, AgentPosition[]>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch agents on mount
  useEffect(() => {
    let mounted = true

    async function loadAgents() {
      try {
        const data = await fetchAgents()
        if (mounted) {
          setAgents(data)
          setIsLoading(false)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load agents')
          setIsLoading(false)
        }
      }
    }

    loadAgents()
    return () => { mounted = false }
  }, [])

  // Fetch positions when expanding an agent
  const handleToggle = async (agentId: string) => {
    if (expandedId === agentId) {
      setExpandedId(null)
      return
    }

    setExpandedId(agentId)

    // Only fetch if we don't have positions cached
    if (!positions[agentId]) {
      setLoadingId(agentId)
      try {
        const detail = await fetchAgent(agentId)
        setPositions(prev => ({ ...prev, [agentId]: detail.positions }))
      } catch (err) {
        console.error(`Failed to load positions for ${agentId}:`, err)
        setPositions(prev => ({ ...prev, [agentId]: [] }))
      } finally {
        setLoadingId(null)
      }
    }
  }

  if (isLoading) {
    return (
      <div className="agent-positions">
        <div className="agent-positions__header">
          <h2 className="agent-positions__title">Strategy Positions</h2>
        </div>
        <div className="agent-positions__loading">Loading agents...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="agent-positions">
        <div className="agent-positions__header">
          <h2 className="agent-positions__title">Strategy Positions</h2>
        </div>
        <div className="agent-positions__error">{error}</div>
      </div>
    )
  }

  return (
    <div className="agent-positions">
      <div className="agent-positions__header">
        <h2 className="agent-positions__title">Strategy Positions</h2>
        <span className="agent-positions__count">
          {agents.length} strateg{agents.length !== 1 ? 'ies' : 'y'}
        </span>
      </div>

      <div className="agent-positions__list">
        {agents.map(agent => (
          <AgentCard
            key={agent.id}
            agent={agent}
            positions={positions[agent.id] || []}
            isExpanded={expandedId === agent.id}
            onToggle={() => handleToggle(agent.id)}
            isLoading={loadingId === agent.id}
          />
        ))}
      </div>
    </div>
  )
}
