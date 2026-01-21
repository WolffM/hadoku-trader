import type { ExecutedTrade } from '../../types/api'
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

function TradeRow({ trade, onExpand, isExpanded }: TradeRowProps) {
  const isBuy = trade.action === 'buy'

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
              <h4 className="trade-details__title">Trade Reasoning</h4>
              <div className="trade-details__grid">
                <div className="trade-details__item">
                  <span className="trade-details__label">Politician</span>
                  <span className="trade-details__value">{trade.reasoning.politician}</span>
                </div>
                <div className="trade-details__item">
                  <span className="trade-details__label">Sources</span>
                  <span className="trade-details__value">{trade.reasoning.source_count}</span>
                </div>
                <div className="trade-details__item">
                  <span className="trade-details__label">Conviction</span>
                  <span className="trade-details__value">
                    {trade.reasoning.conviction_multiplier.toFixed(2)}x
                  </span>
                </div>
                <div className="trade-details__item">
                  <span className="trade-details__label">Priced-In Factor</span>
                  <span className="trade-details__value">
                    {(trade.reasoning.priced_in_factor * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="trade-details__item">
                  <span className="trade-details__label">Position Tier</span>
                  <span className="trade-details__value">{trade.reasoning.position_size_tier}</span>
                </div>
              </div>
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
