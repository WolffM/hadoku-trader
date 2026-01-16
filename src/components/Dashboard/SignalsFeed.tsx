import type { Signal } from '../../types/api'

interface SignalsFeedProps {
  signals: Signal[]
}

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  })
}

function formatPrice(price: number | null): string {
  if (price === null) return 'N/A'
  return `$${price.toFixed(2)}`
}

const SOURCE_LABELS: Record<string, string> = {
  unusual_whales: 'Unusual Whales',
  capitol_trades: 'Capitol Trades',
  quiver_quant: 'Quiver Quant',
  house_stock_watcher: 'House Watcher',
  senate_stock_watcher: 'Senate Watcher'
}

const PARTY_COLORS: Record<string, string> = {
  D: 'signal-card__party--dem',
  R: 'signal-card__party--rep',
  I: 'signal-card__party--ind'
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
          <span className="signal-card__price">{formatPrice(trade.disclosed_price)}</span>
        </div>
      </div>

      <div className="signal-card__footer">
        <span className="signal-card__source">{SOURCE_LABELS[source] || source}</span>
        <span className="signal-card__date">
          Filed {formatDate(trade.filing_date)}
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
  // Sort by filing date, most recent first
  const sortedSignals = [...signals].sort(
    (a, b) => new Date(b.trade.filing_date).getTime() - new Date(a.trade.filing_date).getTime()
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
