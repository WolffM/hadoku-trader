import type { PerformanceData } from '../../types/api'
import { formatPercent } from '../../utils/formatters'

interface OverviewCardsProps {
  performance: PerformanceData
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
  const hadokuReturn = performance.hadoku_performance.total_return_pct
  const signalsReturn = performance.signals_performance.total_return_pct
  const sp500Return = performance.sp500_performance.total_return_pct

  const vsSignals = hadokuReturn - signalsReturn
  const vsSP500 = hadokuReturn - sp500Return

  return (
    <div className="overview-cards">
      <KPICard
        title="Hadoku"
        value={formatPercent(hadokuReturn, 1)}
        changeType={hadokuReturn >= 0 ? 'positive' : 'negative'}
        subtitle="Our trades"
      />

      <KPICard
        title="vs Signals"
        value={formatPercent(vsSignals, 1)}
        changeType={vsSignals >= 0 ? 'positive' : 'negative'}
        subtitle={`Signals: ${formatPercent(signalsReturn, 1)}`}
      />

      <KPICard
        title="vs S&P 500"
        value={formatPercent(vsSP500, 1)}
        changeType={vsSP500 >= 0 ? 'positive' : 'negative'}
        subtitle={`S&P 500: ${formatPercent(sp500Return, 1)}`}
      />
    </div>
  )
}
