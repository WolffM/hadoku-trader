import type { Signal } from '../../types/api'
import { formatDate, formatPrice } from '../../utils/formatters'
import { SOURCE_LABELS, PARTY_COLORS } from '../../constants/labels'

interface SignalsFeedProps {
  signals: Signal[]
}

interface SignalCardProps {
  signal: Signal
}

function SignalCard({ signal }: SignalCardProps) {
  const { politician, trade, source, meta } = signal
  const isBuy = trade.action === 'buy'

  return (
    <div className="signal-card">
      <div className="signal-card__header">
        <div className="signal-card__politician">
          <span className={`signal-card__party ${PARTY_COLORS[politician.party]}`}>
            {politician.party}
          </span>
          <span className="signal-card__name">{politician.name}</span>
        </div>
        <span className={`signal-card__action signal-card__action--${trade.action}`}>
          {isBuy ? 'BUY' : 'SELL'}
        </span>
      </div>

      <div className="signal-card__body">
        <div className="signal-card__ticker">{trade.ticker}</div>
        <div className="signal-card__details">
          <span className="signal-card__size">{trade.position_size}</span>
          <span className="signal-card__price">{formatPrice(trade.disclosure_price)}</span>
        </div>
      </div>

      <div className="signal-card__footer">
        <span className="signal-card__source">{SOURCE_LABELS[source] || source}</span>
        <span className="signal-card__date">
          Disclosed {formatDate(trade.disclosure_date)}
          <a
            href={meta.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="signal-card__link"
          >
            View
          </a>
        </span>
      </div>
    </div>
  )
}

export function SignalsFeed({ signals }: SignalsFeedProps) {
  // Sort by disclosure date, most recent first
  const sortedSignals = [...signals].sort(
    (a, b) => new Date(b.trade.disclosure_date).getTime() - new Date(a.trade.disclosure_date).getTime()
  )

  return (
    <div className="signals-feed">
      <div className="signals-feed__header">
        <h2 className="signals-feed__title">Recent Signals</h2>
        <span className="signals-feed__count">{signals.length} signals</span>
      </div>

      <div className="signals-feed__list">
        {sortedSignals.map(signal => (
          <SignalCard key={signal.id} signal={signal} />
        ))}
      </div>
    </div>
  )
}
