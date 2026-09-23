/**
 * `movers` report — comparison-shaped. Surfaces who's rising / declining /
 * within striking distance over a current vs prior window.
 *
 * Plan steps:
 *   - movers-rising / movers-declining (required) — current vs prior mover rows, one direction each
 *   - decay (optional)               — pages losing clicks
 *   - striking-distance (optional)   — queries on positions 4–20
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'
import { requireComparisonWindow } from '../require'
import { reportRows, resultTotal, sectionArtifact, sectionCoverage, truncation } from '../sections'

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
      // One step per direction: a shared top-N by absolute delta lets large
      // gains crowd every decline out of the page, and the reverse.
      { key: 'movers-rising', type: 'movers', params: { ...cur, ...prev, direction: 'rising', limit: 200 }, required: true, feeds: ['rising'] },
      { key: 'movers-declining', type: 'movers', params: { ...cur, ...prev, direction: 'declining', limit: 200 }, required: true, feeds: ['decliners'] },
      { key: 'decay', type: 'decay', params: { ...cur, ...prev, limit: 100 }, feeds: ['decliners'] },
      { key: 'striking', type: 'striking-distance', params: { ...cur, limit: 100 }, feeds: ['striking-distance'] },
    ]
  },
  reduce: (results, ctx) => {
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    const minChange = ctx.params.minClicksChange ?? DEFAULT_MIN_CHANGE

    const sections: ReportSection[] = []
    const risingRes = results['movers-rising'] as AnalysisResult | undefined
    const decliningRes = results['movers-declining'] as AnalysisResult | undefined
    const decayRes = results.decay as AnalysisResult | undefined
    const strikingRes = results.striking as AnalysisResult | undefined

    sections.push(buildMoversSection(risingRes, 'rising', max, minChange))
    sections.push(buildDeclinersSection(decliningRes, decayRes, max, minChange))
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
  /** `null` for brand-new keywords with no previous-period position to diff against. */
  positionChange: number | null
  direction: 'rising' | 'declining' | 'stable'
}

function buildMoversSection(
  res: AnalysisResult | undefined,
  direction: 'rising' | 'declining',
  max: number,
  minChange: number,
): ReportSection {
  const rows = reportRows<MoverRow>(res)
    .filter(r => r.direction === direction && Math.abs(r.clicksChange) >= minChange)
    .sort((a, b) => Math.abs(b.clicksChange) - Math.abs(a.clicksChange))

  const total = resultTotal(res, rows.length)
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.keyword },
    metrics: {
      clicks: r.recentClicks,
      clicksChange: r.clicksChange,
      clicksChangePercent: r.clicksChangePercent,
      // Omit rather than fake a 0 — `ReportFinding.metrics` is a plain
      // Record<string, number>, and this is null for brand-new keywords.
      ...(r.positionChange != null ? { positionChange: r.positionChange } : {}),
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
    truncated: truncation(total, kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'movers'),
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
  const decliningRows = reportRows<MoverRow>(moversRes)
    .filter(r => r.direction === 'declining' && Math.abs(r.clicksChange) >= minChange)
    .sort((a, b) => Math.abs(b.clicksChange) - Math.abs(a.clicksChange))
  const decliningQueries = decliningRows.slice(0, max)

  const lostPages = reportRows<DecayRow>(decayRes)
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
    truncated: truncation(resultTotal(moversRes, decliningRows.length), decliningQueries.length),
    coverage: sectionCoverage(moversRes) === 'full' && sectionCoverage(decayRes) === 'full' ? 'full' : 'partial',
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
  const rows = reportRows<StrikingRow>(res)
    .sort((a, b) => b.potentialClicks - a.potentialClicks)
  const kept = rows.slice(0, max)
  const total = resultTotal(res, rows.length)

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
    truncated: truncation(total, kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'striking-distance'),
  }
}
