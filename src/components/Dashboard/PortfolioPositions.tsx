import type { PortfolioData } from '../../types/api'

interface PortfolioPositionsProps {
  data: PortfolioData
}

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

export function PortfolioPositions({ data }: PortfolioPositionsProps) {
  // Sort positions by market value, highest first
  const sortedPositions = [...data.positions].sort((a, b) => b.market_value - a.market_value)

  return (
    <div className="portfolio-positions">
      <div className="portfolio-positions__header">
        <h2 className="portfolio-positions__title">Portfolio</h2>
        <span className="portfolio-positions__total">{formatCurrency(data.total_value)}</span>
      </div>

      <div className="portfolio-positions__list">
        {sortedPositions.map(position => {
          const isProfitable = position.unrealized_pnl >= 0
          const allocation = (position.market_value / data.total_value) * 100

          return (
            <div key={position.ticker} className="position-card">
              <div className="position-card__main">
                <div className="position-card__ticker-group">
                  <span className="position-card__ticker">{position.ticker}</span>
                  <span className="position-card__quantity">{position.quantity} shares</span>
                </div>
                <div className="position-card__value-group">
                  <span className="position-card__value">
                    {formatCurrency(position.market_value)}
                  </span>
                  <span
                    className={`position-card__pnl ${isProfitable ? 'position-card__pnl--profit' : 'position-card__pnl--loss'}`}
                  >
                    {formatPercent(position.unrealized_pnl_pct)}
                  </span>
                </div>
              </div>

              <div className="position-card__bar">
                <div
                  className="position-card__bar-fill"
                  style={{ width: `${allocation}%` }}
                  title={`${allocation.toFixed(1)}% of portfolio`}
                />
              </div>

              <div className="position-card__details">
                <span className="position-card__detail">
                  Avg: {formatCurrency(position.avg_cost)}
                </span>
                <span className="position-card__detail">
                  Now: {formatCurrency(position.current_price)}
                </span>
                <span
                  className={`position-card__detail ${isProfitable ? 'position-card__detail--profit' : 'position-card__detail--loss'}`}
                >
                  P&L: {formatCurrency(position.unrealized_pnl)}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="portfolio-positions__cash">
        <span className="portfolio-positions__cash-label">Cash</span>
        <span className="portfolio-positions__cash-value">{formatCurrency(data.cash)}</span>
      </div>
    </div>
  )
}
