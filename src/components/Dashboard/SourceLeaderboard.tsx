import type { SourcePerformance } from '../../types/api'

interface SourceLeaderboardProps {
  sources: SourcePerformance[]
}

const SOURCE_LABELS: Record<string, string> = {
  unusual_whales: 'Unusual Whales',
  capitol_trades: 'Capitol Trades',
  quiver_quant: 'Quiver Quant',
  house_stock_watcher: 'House Watcher',
  senate_stock_watcher: 'Senate Watcher'
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

export function SourceLeaderboard({ sources }: SourceLeaderboardProps) {
  // Sort by average return, highest first
  const sortedSources = [...sources].sort((a, b) => b.avg_return_pct - a.avg_return_pct)

  return (
    <div className="source-leaderboard">
      <div className="source-leaderboard__header">
        <h2 className="source-leaderboard__title">Source Performance</h2>
      </div>

      <div className="source-leaderboard__list">
        {sortedSources.map((source, index) => {
          const winRatePct = source.win_rate * 100
          const executionRate = (source.executed_signals / source.total_signals) * 100

          return (
            <div key={source.name} className="source-card">
              <div className="source-card__rank">#{index + 1}</div>

              <div className="source-card__main">
                <div className="source-card__name">
                  {SOURCE_LABELS[source.name] || source.name}
                </div>
                <div className="source-card__stats">
                  <span className="source-card__stat">
                    <span className="source-card__stat-value">
                      {formatPercent(source.avg_return_pct)}
                    </span>
                    <span className="source-card__stat-label">Avg Return</span>
                  </span>
                  <span className="source-card__stat">
                    <span className="source-card__stat-value">{winRatePct.toFixed(0)}%</span>
                    <span className="source-card__stat-label">Win Rate</span>
                  </span>
                  <span className="source-card__stat">
                    <span className="source-card__stat-value">{source.executed_signals}</span>
                    <span className="source-card__stat-label">Executed</span>
                  </span>
                </div>
              </div>

              <div className="source-card__bar">
                <div
                  className="source-card__bar-fill source-card__bar-fill--win"
                  style={{ width: `${winRatePct}%` }}
                  title={`Win rate: ${winRatePct.toFixed(0)}%`}
                />
              </div>

              <div className="source-card__execution">
                <span className="source-card__execution-text">
                  {executionRate.toFixed(0)}% executed ({source.executed_signals}/
                  {source.total_signals})
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
