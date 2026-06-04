/**
 * `movers` report — comparison-shaped. Surfaces who's rising / declining /
 * within striking distance over a current vs prior window.
 *
 * Plan steps:
 *   - movers (required)              — current vs prior aggregated mover rows
 *   - decay (optional)               — pages losing clicks
 *   - striking-distance (optional)   — queries on positions 4–20
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'
import { requireComparisonWindow } from '../require'

export interface MoversReportParams {
  /** Cap findings per section. Default 5. */
  maxFindings?: number
  /** Lower bound for absolute click change to qualify as "moved". Default 5. */
  minClicksChange?: number
}

const DEFAULT_MAX = 5
const DEFAULT_MIN_CHANGE = 5

export const moversReport = defineReport<MoversReportParams>({
  id: 'movers',
  description: 'Risers, decliners, and striking-distance opportunities over a current vs prior window.',
  defaultPeriod: 'last-7d',
  defaultComparison: 'prev-period',
  argsSpec: {
    'max-findings': { type: 'number', description: 'Cap findings per section', default: DEFAULT_MAX },
    'min-clicks-change': { type: 'number', description: 'Min absolute click change', default: DEFAULT_MIN_CHANGE },
  },
  plan: (_params, window) => {
    const comparison = requireComparisonWindow('movers', window, 'movers report requires a comparison window — pass --vs prev-period')
    const cur = { startDate: window.start, endDate: window.end }
    const prev = { prevStartDate: comparison.start, prevEndDate: comparison.end }
    return [
      { key: 'movers', type: 'movers', params: { ...cur, ...prev, limit: 200 }, required: true },
      { key: 'decay', type: 'decay', params: { ...cur, ...prev, limit: 100 } },
      { key: 'striking', type: 'striking-distance', params: { ...cur, limit: 100 } },
    ]
  },
  reduce: (results, ctx) => {
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    const minChange = ctx.params.minClicksChange ?? DEFAULT_MIN_CHANGE

    const sections: ReportSection[] = []
    const moversRes = results.movers as AnalysisResult | undefined
    const decayRes = results.decay as AnalysisResult | undefined
    const strikingRes = results.striking as AnalysisResult | undefined

    sections.push(buildMoversSection(moversRes, 'rising', max, minChange))
    sections.push(buildDeclinersSection(moversRes, decayRes, max, minChange))
    sections.push(buildStrikingSection(strikingRes, max))
    return { sections }
  },
})

interface MoverRow {
  keyword: string
  page: string | null
  recentClicks: number
  baselineClicks: number
  clicksChange: number
  clicksChangePercent: number
  positionChange: number
  direction: 'rising' | 'declining' | 'stable'
}

function buildMoversSection(
  res: AnalysisResult | undefined,
  direction: 'rising' | 'declining',
  max: number,
  minChange: number,
): ReportSection {
  const rows = ((res?.results ?? []) as unknown as MoverRow[])
    .filter(r => r.direction === direction && Math.abs(r.clicksChange) >= minChange)
    .sort((a, b) => Math.abs(b.clicksChange) - Math.abs(a.clicksChange))

  const total = rows.length
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.keyword },
    metrics: {
      clicks: r.recentClicks,
      clicksChange: r.clicksChange,
      clicksChangePercent: r.clicksChangePercent,
      positionChange: r.positionChange,
    },
    delta: {
      metric: 'clicks',
      prior: r.baselineClicks,
      current: r.recentClicks,
      pct: r.clicksChangePercent,
    },
    why: r.page ? `on ${r.page}` : undefined,
  }))

  const totalDelta = kept.reduce((sum, r) => sum + r.clicksChange, 0)
  return {
    id: direction,
    title: direction === 'rising' ? 'Rising queries' : 'Declining queries',
    severity: direction === 'rising' ? 'info' : 'medium',
    summary: {
      delta: totalDelta,
      direction: totalDelta > 0 ? 'up' : totalDelta < 0 ? 'down' : 'flat',
    },
    findings,
    truncated: total > max ? { kept: kept.length, total } : undefined,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'movers', params: { type: 'movers' } } : undefined,
  }
}

interface DecayRow {
  page: string
  currentClicks: number
  previousClicks: number
  lostClicks: number
  declinePercent: number
}

function buildDeclinersSection(
  moversRes: AnalysisResult | undefined,
  decayRes: AnalysisResult | undefined,
  max: number,
  minChange: number,
): ReportSection {
  const decliningQueries = ((moversRes?.results ?? []) as unknown as MoverRow[])
    .filter(r => r.direction === 'declining' && Math.abs(r.clicksChange) >= minChange)
    .slice(0, max)

  const lostPages = ((decayRes?.results ?? []) as unknown as DecayRow[])
    .sort((a, b) => b.lostClicks - a.lostClicks)
    .slice(0, max)

  const findings: ReportFinding[] = [
    ...decliningQueries.map((r): ReportFinding => ({
      entity: { kind: 'query', value: r.keyword },
      metrics: { clicks: r.recentClicks, clicksChange: r.clicksChange },
      delta: { metric: 'clicks', prior: r.baselineClicks, current: r.recentClicks, pct: r.clicksChangePercent },
    })),
    ...lostPages.map((r): ReportFinding => ({
      entity: { kind: 'page', value: r.page },
      metrics: { clicks: r.currentClicks, lostClicks: r.lostClicks, declinePercent: r.declinePercent },
      delta: { metric: 'clicks', prior: r.previousClicks, current: r.currentClicks, pct: -r.declinePercent * 100 },
      why: 'page-level decay',
    })),
  ]

  const totalLost = decliningQueries.reduce((s, r) => s + Math.abs(r.clicksChange), 0)
    + lostPages.reduce((s, r) => s + r.lostClicks, 0)
  const severity = totalLost >= 100 ? 'high' : totalLost >= 25 ? 'medium' : 'low'

  return {
    id: 'decliners',
    title: 'Decliners',
    severity,
    summary: { delta: -totalLost, direction: totalLost > 0 ? 'down' : 'flat', magnitudeLabel: `${Math.round(totalLost)} clicks lost` },
    findings,
    coverage: decayRes && moversRes ? 'full' : 'partial',
    actions: lostPages.slice(0, 1).map(r => ({
      kind: 'analyzer',
      target: { kind: 'page', value: r.page },
      params: { type: 'change-point' },
      rationale: 'Investigate the change-point on the worst-affected page',
      cliHint: `gscdump analyze change-point --start <date> --end <date>`,
    })),
  }
}

interface StrikingRow {
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  potentialClicks: number
}

function buildStrikingSection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = ((res?.results ?? []) as unknown as StrikingRow[])
    .sort((a, b) => b.potentialClicks - a.potentialClicks)
  const kept = rows.slice(0, max)

  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.keyword },
    metrics: {
      position: r.position,
      impressions: r.impressions,
      clicks: r.clicks,
      potentialClicks: r.potentialClicks,
    },
    why: r.page ? `currently on ${r.page}` : undefined,
  }))

  return {
    id: 'striking-distance',
    title: 'Striking-distance opportunities',
    severity: 'low',
    summary: { magnitudeLabel: `${kept.reduce((s, r) => s + r.potentialClicks, 0)} potential clicks` },
    findings,
    truncated: rows.length > max ? { kept: kept.length, total: rows.length } : undefined,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'striking-distance', params: { type: 'striking-distance' } } : undefined,
  }
}
