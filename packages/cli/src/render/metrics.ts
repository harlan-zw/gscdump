export type MetricUnit = 'count' | 'ratio' | 'share' | 'percentage' | 'factor' | 'position' | 'bytes'

interface Metric {
  label: string
  unit: MetricUnit
}

const METRICS: Record<string, Metric> = {
  clicks: { label: 'Clicks', unit: 'count' },
  impressions: { label: 'Impressions', unit: 'count' },
  totalClicks: { label: 'Clicks', unit: 'count' },
  totalImpressions: { label: 'Impressions', unit: 'count' },
  recentClicks: { label: 'Clicks', unit: 'count' },
  baselineClicks: { label: 'Previous clicks', unit: 'count' },
  prevClicks: { label: 'Previous clicks', unit: 'count' },
  ctr: { label: 'CTR', unit: 'ratio' },
  avgCtr: { label: 'CTR', unit: 'ratio' },
  position: { label: 'Average position', unit: 'position' },
  avgPosition: { label: 'Average position', unit: 'position' },
  recentPosition: { label: 'Average position', unit: 'position' },
  prevPosition: { label: 'Previous position', unit: 'position' },
  growthRatio: { label: 'Growth', unit: 'factor' },
  vsAverage: { label: 'Vs average', unit: 'factor' },
  brandShare: { label: 'Brand share', unit: 'share' },
  share: { label: 'Share', unit: 'share' },
  topNConcentration: { label: 'Top share', unit: 'share' },
  declinePercent: { label: 'Decline', unit: 'share' },
  clicksChangePercent: { label: 'Click change', unit: 'percentage' },
  impressionsChangePercent: { label: 'Impression change', unit: 'percentage' },
  bytes: { label: 'Bytes', unit: 'bytes' },
  liveBytes: { label: 'Live bytes', unit: 'bytes' },
  liveRows: { label: 'Rows', unit: 'count' },
  liveFiles: { label: 'Files', unit: 'count' },
}

export function metricLabel(key: string): string {
  return METRICS[key]?.label ?? (key === 'keyword' ? 'query' : key)
}

export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function formatMetric(key: string, value: unknown): string {
  const n = finite(value)
  if (n === null)
    return 'n/a'
  const unit = METRICS[key]?.unit
  if ((unit === 'ratio' || unit === 'share') && (n < 0 || n > 1))
    return 'n/a'
  if (unit === 'factor' && !Number.isFinite((n - 1) * 100))
    return 'n/a'
  switch (unit) {
    case 'count': return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    case 'ratio': return `${(n * 100).toFixed(2)}%`
    case 'share': return `${(n * 100).toFixed(1)}%`
    case 'percentage': return `${signed(n, 1)}%`
    case 'factor': return `${signed((n - 1) * 100, 1)}%`
    case 'position': return n.toFixed(1)
    case 'bytes': {
      const scale = n >= 1024 ** 3 ? 3 : n >= 1024 ** 2 ? 2 : n >= 1024 ? 1 : 0
      return `${(n / 1024 ** scale).toFixed(scale === 0 ? 0 : 2)} ${['B', 'KiB', 'MiB', 'GiB'][scale]}`
    }
    default: return String(n)
  }
}

export function signed(n: number, decimals = 0): string {
  if (!Number.isFinite(n))
    return 'n/a'
  const rounded = Number(n.toFixed(decimals))
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

export function formatChange(key: string, current: number, previous: number | null): { text: string, direction: 'good' | 'bad' | 'neutral' } {
  if (previous === null || !Number.isFinite(current) || !Number.isFinite(previous))
    return { text: 'No baseline.', direction: 'neutral' }
  const difference = current - previous
  const unit = METRICS[key]?.unit
  const direction = difference === 0 || unit === 'share'
    ? 'neutral'
    : (unit === 'position' ? difference < 0 : difference > 0) ? 'good' : 'bad'
  if (unit === 'position')
    return { text: difference === 0 ? 'unchanged' : `${difference < 0 ? 'improved' : 'worsened'} ${Math.abs(difference).toFixed(1)}`, direction }
  if (unit === 'ratio' || unit === 'share')
    return { text: `${signed(difference * 100, 2)} pp`, direction }
  return {
    text: previous === 0
      ? `${signed(difference)} (previous: 0)`
      : `${signed(difference)} (${signed(difference / Math.abs(previous) * 100, 1)}%)`,
    direction,
  }
}
