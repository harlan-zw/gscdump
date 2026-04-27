// Semantic color map ported from nuxtseo/nuxt-seo-pro. One source of truth for
// status/threshold/trend coloring across every Ui* component so consumers
// stay visually consistent.
//
// Deliberately keeps three scopes separate:
//  - Status    — success/error/warning/info/neutral for health, connection, validation
//  - Threshold — good/attention/poor for CWV, indexing %, etc.
//  - Trend     — positive/negative/neutral for deltas
//
// Metric viz colors (clicks=blue, impressions=purple, etc.) are not here —
// those are data-viz concerns owned by chart components.

export type SemanticStatus = 'success' | 'error' | 'warning' | 'info' | 'neutral'
export type HealthStatus = 'healthy' | 'attention' | 'issues' | 'unknown'

export interface SemanticColorSet {
  text: string
  bg: string
  dot: string
  border: string
  hex: string
}

export const semanticColors: Record<SemanticStatus, SemanticColorSet> = {
  success: { text: 'text-success', bg: 'bg-success/10', dot: 'bg-success', border: 'border-success/20', hex: '#22c55e' },
  error: { text: 'text-error', bg: 'bg-error/10', dot: 'bg-error', border: 'border-error/20', hex: '#ef4444' },
  warning: { text: 'text-warning', bg: 'bg-warning/10', dot: 'bg-warning', border: 'border-warning/20', hex: '#eab308' },
  info: { text: 'text-info', bg: 'bg-info/10', dot: 'bg-info', border: 'border-info/20', hex: '#3b82f6' },
  neutral: { text: 'text-muted', bg: 'bg-accented', dot: 'bg-[var(--ui-border)]', border: 'border-default', hex: '#94a3b8' },
}

export function healthToSemantic(health: HealthStatus | null): SemanticStatus {
  switch (health) {
    case 'healthy': return 'success'
    case 'attention': return 'warning'
    case 'issues': return 'error'
    default: return 'neutral'
  }
}

export function thresholdToSemantic(value: number, good: number, poor: number): SemanticStatus {
  if (value <= good)
    return 'success'
  if (value <= poor)
    return 'warning'
  return 'error'
}

export function trendToSemantic(value: number): SemanticStatus {
  if (value > 0)
    return 'success'
  if (value < 0)
    return 'error'
  return 'neutral'
}

export function healthColors(health: HealthStatus | null): SemanticColorSet {
  return semanticColors[healthToSemantic(health)]
}

export function thresholdColors(value: number, good: number, poor: number): SemanticColorSet {
  return semanticColors[thresholdToSemantic(value, good, poor)]
}

export function thresholdHex(value: number, good: number, poor: number): string {
  return thresholdColors(value, good, poor).hex
}
