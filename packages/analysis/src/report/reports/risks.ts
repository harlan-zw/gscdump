/**
 * `risks` report — surfaces threats: page-level decay, cannibalization
 * (multiple pages competing for one query), dark traffic (unattributed
 * clicks), and device-gap regressions.
 *
 * Comparison-shaped (decay needs prior period). Default 28d vs prior.
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection, ReportSeverity } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'
import { requireComparisonWindow } from '../require'
import { reportRows, sectionArtifact, sectionCoverage, truncation } from '../sections'

export interface RisksReportParams {
  maxFindings?: number
}

const DEFAULT_MAX = 5

export const risksReport = defineReport<RisksReportParams>({
  id: 'risks',
  description: 'Decay, cannibalization, dark-traffic and device-gap risks vs prior period.',
  defaultPeriod: 'last-28d',
  defaultComparison: 'prev-period',
  argsSpec: {
    'max-findings': { type: 'number', description: 'Cap findings per section', default: DEFAULT_MAX },
  },
  plan: (_params, window) => {
    const comparison = requireComparisonWindow('risks', window, 'risks report requires a comparison window — pass --vs prev-period')
    const dates = { startDate: window.start, endDate: window.end }
    const prev = { prevStartDate: comparison.start, prevEndDate: comparison.end }
    return [
      { key: 'decay', type: 'decay', params: { ...dates, ...prev, limit: 100 }, required: true },
      { key: 'cannibalization', type: 'cannibalization', params: { ...dates, limit: 50 } },
      { key: 'dark-traffic', type: 'dark-traffic', params: { ...dates, limit: 50 } },
      { key: 'device-gap', type: 'device-gap', params: { ...dates, limit: 50 } },
    ]
  },
  reduce: (results, ctx) => {
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    return {
      sections: [
        buildDecaySection(results.decay, max),
        buildCannibalizationSection(results.cannibalization, max),
        buildDarkTrafficSection(results['dark-traffic'], max),
        buildDeviceGapSection(results['device-gap'], max),
      ],
    }
  },
})

interface DecayRow {
  page: string
  currentClicks: number
  previousClicks: number
  lostClicks: number
  declinePercent: number
}

function buildDecaySection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<DecayRow>(res)
    .sort((a, b) => b.lostClicks - a.lostClicks)
  const kept = rows.slice(0, max)
  const totalLost = kept.reduce((s, r) => s + r.lostClicks, 0)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'page', value: r.page },
    metrics: { lostClicks: r.lostClicks, currentClicks: r.currentClicks, declinePercent: r.declinePercent },
    delta: { metric: 'clicks', prior: r.previousClicks, current: r.currentClicks, pct: -r.declinePercent * 100 },
  }))
  const severity: ReportSeverity = totalLost >= 200 ? 'high' : totalLost >= 50 ? 'medium' : 'low'
  return {
    id: 'decay',
    title: 'Decaying pages',
    severity,
    summary: { delta: -totalLost, direction: totalLost > 0 ? 'down' : 'flat', magnitudeLabel: `${Math.round(totalLost)} clicks lost` },
    findings,
    truncated: truncation(rows.length, kept.length),
    coverage: sectionCoverage(res),
    actions: kept.slice(0, 1).map(r => ({
      kind: 'analyzer',
      target: { kind: 'page', value: r.page },
      params: { type: 'change-point' },
      rationale: 'Investigate change-point on the worst-affected page',
    })),
    artifact: sectionArtifact(res, 'decay'),
  }
}

interface CannibalizationRow {
  keyword: string
  totalClicks: number
  totalImpressions: number
  competitorCount: number
  competitors: { url: string }[]
}

function buildCannibalizationSection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<CannibalizationRow>(res)
    .sort((a, b) => b.totalClicks - a.totalClicks)
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map((r) => {
    const pageCount = r.competitorCount ?? r.competitors?.length ?? 0
    return {
      entity: { kind: 'query', value: r.keyword },
      metrics: {
        pages: pageCount,
        totalClicks: r.totalClicks,
        totalImpressions: r.totalImpressions,
      },
      why: `${pageCount} pages competing`,
    }
  })
  return {
    id: 'cannibalization',
    title: 'Cannibalizing queries',
    severity: kept.length ? 'medium' : 'info',
    summary: {},
    findings,
    truncated: truncation(rows.length, kept.length),
    coverage: sectionCoverage(res),
    actions: [],
    artifact: sectionArtifact(res, 'cannibalization'),
  }
}

interface DarkTrafficRow {
  url: string
  totalClicks: number
  attributedClicks: number
  darkClicks: number
  darkPercent: number
}

function buildDarkTrafficSection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<DarkTrafficRow>(res)
    .sort((a, b) => b.darkClicks - a.darkClicks)
  const kept = rows.slice(0, max)
  const totalDark = kept.reduce((s, r) => s + r.darkClicks, 0)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'page', value: r.url },
    metrics: { darkClicks: r.darkClicks, darkPercent: r.darkPercent, totalClicks: r.totalClicks },
  }))
  return {
    id: 'dark-traffic',
    title: 'Dark traffic',
    severity: kept.length ? 'low' : 'info',
    summary: { magnitudeLabel: `${Math.round(totalDark)} unattributed clicks` },
    findings,
    truncated: truncation(rows.length, kept.length),
    coverage: sectionCoverage(res),
    actions: [],
    artifact: sectionArtifact(res, 'dark-traffic'),
  }
}

interface DeviceGapRow {
  date: string
  desktop: { ctr: number, position: number }
  mobile: { ctr: number, position: number }
  gaps: { ctrGap: number, positionGap: number }
}

function buildDeviceGapSection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<DeviceGapRow>(res)
    .sort((a, b) => Math.abs(b.gaps.positionGap) - Math.abs(a.gaps.positionGap))
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'page', value: r.date },
    metrics: {
      ctrGap: r.gaps.ctrGap,
      positionGap: r.gaps.positionGap,
      desktopCtr: r.desktop.ctr,
      mobileCtr: r.mobile.ctr,
    },
    why: `desktop vs mobile delta`,
  }))
  return {
    id: 'device-gap',
    title: 'Device gap',
    severity: 'info',
    summary: {},
    findings,
    truncated: truncation(rows.length, kept.length),
    coverage: sectionCoverage(res),
    actions: [],
    artifact: sectionArtifact(res, 'device-gap'),
  }
}
