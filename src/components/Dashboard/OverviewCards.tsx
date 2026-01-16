import type { PerformanceData } from '../../types/api'

interface OverviewCardsProps {
  performance: PerformanceData
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

interface KPICardProps {
  title: string
  value: string
  change?: string
  changeType?: 'positive' | 'negative' | 'neutral'
  subtitle?: string
}

function KPICard({ title, value, change, changeType = 'neutral', subtitle }: KPICardProps) {
  return (
    <div className="kpi-card">
      <div className="kpi-card__header">
        <span className="kpi-card__title">{title}</span>
        {change && (
          <span className={`kpi-card__change kpi-card__change--${changeType}`}>{change}</span>
        )}
      </div>
      <div className="kpi-card__value">{value}</div>
      {subtitle && <div className="kpi-card__subtitle">{subtitle}</div>}
    </div>
  )
}

export function OverviewCards({ performance }: OverviewCardsProps) {
  const portfolioReturn = performance.portfolio_performance.total_return_pct
  const signalsReturn = performance.signals_performance.total_return_pct
  const sp500Return = performance.sp500_performance.total_return_pct

  const vsSignals = portfolioReturn - signalsReturn
  const vsSP500 = portfolioReturn - sp500Return

  return (
    <div className="overview-cards">
      <KPICard
        title="My Return"
        value={formatPercent(portfolioReturn)}
        changeType={portfolioReturn >= 0 ? 'positive' : 'negative'}
        subtitle="Total return"
      />

      <KPICard
        title="vs Signals"
        value={formatPercent(vsSignals)}
        changeType={vsSignals >= 0 ? 'positive' : 'negative'}
        subtitle={`Signals: ${formatPercent(signalsReturn)}`}
      />

      <KPICard
        title="vs S&P 500"
        value={formatPercent(vsSP500)}
        changeType={vsSP500 >= 0 ? 'positive' : 'negative'}
        subtitle={`S&P 500: ${formatPercent(sp500Return)}`}
      />
    </div>
  )
}
