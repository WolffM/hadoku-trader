import type { ExecutedTrade, SizingReasoning } from '../../types/api'
import { formatCurrency, formatDate } from '../../utils/formatters'
import { STATUS_CLASSES } from '../../constants/labels'

interface TradeLogProps {
  trades: ExecutedTrade[]
}

interface TradeRowProps {
  trade: ExecutedTrade
  onExpand: (id: string) => void
  isExpanded: boolean
}

function isSizingReasoning(r: ExecutedTrade['reasoning']): r is SizingReasoning {
  return !!r && typeof r === 'object' && 'mode' in r && 'bound_by' in r
}

function TradeRow({ trade, onExpand, isExpanded }: TradeRowProps) {
  const isBuy = trade.action === 'buy'
  const sizing = isSizingReasoning(trade.reasoning) ? trade.reasoning : null
  const breakdown = trade.score_breakdown ?? null

  return (
    <>
      <tr className="trade-row" onClick={() => onExpand(trade.id)}>
        <td className="trade-row__date">{formatDate(trade.date, true)}</td>
        <td className="trade-row__ticker">{trade.ticker}</td>
        <td className={`trade-row__action trade-row__action--${trade.action}`}>
          {isBuy ? 'BUY' : 'SELL'}
        </td>
        <td className="trade-row__quantity">{trade.quantity}</td>
        <td className="trade-row__price">{formatCurrency(trade.price)}</td>
        <td className="trade-row__total">{formatCurrency(trade.total)}</td>
        <td className={`trade-row__status ${STATUS_CLASSES[trade.status]}`}>{trade.status}</td>
        <td className="trade-row__expand">{isExpanded ? '−' : '+'}</td>
      </tr>
      {isExpanded && (
        <tr className="trade-row__details">
          <td colSpan={8}>
            <div className="trade-details">
              <h4 className="trade-details__title">Decision</h4>
              <div className="trade-details__grid">
                <div className="trade-details__item">
                  <span className="trade-details__label">Agent</span>
                  <span className="trade-details__value">{trade.agent_id ?? '—'}</span>
                </div>
                <div className="trade-details__item">
                  <span className="trade-details__label">Decision</span>
                  <span className="trade-details__value">{trade.decision ?? '—'}</span>
                </div>
                <div className="trade-details__item">
                  <span className="trade-details__label">Score</span>
                  <span className="trade-details__value">
                    {typeof trade.score === 'number' ? trade.score.toFixed(3) : '—'}
                  </span>
                </div>
                {trade.error_message && (
                  <div className="trade-details__item">
                    <span className="trade-details__label">Error</span>
                    <span className="trade-details__value">{trade.error_message}</span>
                  </div>
                )}
              </div>

              {sizing && (
                <>
                  <h4 className="trade-details__title">Sizing</h4>
                  <div className="trade-details__grid">
                    <div className="trade-details__item">
                      <span className="trade-details__label">Mode</span>
                      <span className="trade-details__value">{sizing.mode}</span>
                    </div>
                    <div className="trade-details__item">
                      <span className="trade-details__label">Raw size</span>
                      <span className="trade-details__value">
                        {formatCurrency(sizing.raw_size)}
                      </span>
                    </div>
                    <div className="trade-details__item">
                      <span className="trade-details__label">Final size</span>
                      <span className="trade-details__value">
                        {formatCurrency(sizing.final_size)}
                      </span>
                    </div>
                    <div className="trade-details__item">
                      <span className="trade-details__label">Bound by</span>
                      <span className="trade-details__value">{sizing.bound_by}</span>
                    </div>
                    <div className="trade-details__item">
                      <span className="trade-details__label">Budget remaining</span>
                      <span className="trade-details__value">
                        {formatCurrency(sizing.budget_remaining_at_eval)}
                      </span>
                    </div>
                  </div>
                </>
              )}

              {breakdown && (
                <>
                  <h4 className="trade-details__title">Score breakdown</h4>
                  <div className="trade-details__grid">
                    {Object.entries(breakdown).map(([k, v]) => (
                      <div className="trade-details__item" key={k}>
                        <span className="trade-details__label">{k}</span>
                        <span className="trade-details__value">
                          {typeof v === 'number' ? v.toFixed(3) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

import { useState } from 'react'

export function TradeLog({ trades }: TradeLogProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Sort by date, most recent first
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  )

  const handleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  return (
    <div className="trade-log">
      <div className="trade-log__header">
        <h2 className="trade-log__title">Trade History</h2>
        <span className="trade-log__count">{trades.length} trades</span>
      </div>

      <div className="trade-log__table-container">
        <table className="trade-log__table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Ticker</th>
              <th>Action</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sortedTrades.map(trade => (
              <TradeRow
                key={trade.id}
                trade={trade}
                onExpand={handleExpand}
                isExpanded={expandedId === trade.id}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
