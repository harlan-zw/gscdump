/**
 * `health` report — anomaly-shaped. Surfaces unexpected drops/changes in the
 * recent window; no comparison required (anomaly detectors compare against
 * their own rolling baselines).
 *
 * v1 plan (per REPORTS_PLAN.md): ctr-anomaly + change-point + position-volatility.
 * Indexing-status drops out — it isn't an analyzer.
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'
import { reportRows, sectionArtifact, sectionCoverage, truncation } from '../sections'

export interface HealthReportParams {
  maxFindings?: number
}

const DEFAULT_MAX = 5

export const healthReport = defineReport<HealthReportParams>({
  id: 'health',
  description: 'CTR anomalies, change-points, and position-volatility hot spots in the recent window.',
  defaultPeriod: 'last-28d',
  defaultComparison: 'none',
  argsSpec: {
    'max-findings': { type: 'number', description: 'Cap findings per section', default: DEFAULT_MAX },
  },
  plan: (_params, window) => {
    const dates = { startDate: window.start, endDate: window.end }
    return [
      { key: 'ctr-anomaly', type: 'ctr-anomaly', params: { ...dates, limit: 100 }, required: true },
      { key: 'change-point', type: 'change-point', params: { ...dates, limit: 100 } },
      { key: 'position-volatility', type: 'position-volatility', params: { ...dates, limit: 100 } },
    ]
  },
  reduce: (results, ctx) => {
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    return {
      sections: [
        buildCtrAnomalySection(results['ctr-anomaly'], max),
        buildChangePointSection(results['change-point'], max),
        buildPositionVolatilitySection(results['position-volatility'], max),
      ],
    }
  },
})

interface CtrAnomalyRow {
  keyword: string
  page: string
  breachDaysDown: number
  clicksLost: number
  severity: number
  baselineCtr: number
  totalImpressions: number
}

function buildCtrAnomalySection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<CtrAnomalyRow>(res)
    .filter(r => r.breachDaysDown > 0)
    .sort((a, b) => b.clicksLost - a.clicksLost)
  const kept = rows.slice(0, max)

  const totalLost = kept.reduce((s, r) => s + r.clicksLost, 0)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.keyword },
    metrics: {
      clicksLost: r.clicksLost,
      breachDays: r.breachDaysDown,
      severity: r.severity,
      baselineCtr: r.baselineCtr,
    },
    why: r.page ? `on ${r.page}` : undefined,
  }))

  const severity = totalLost >= 100 ? 'high' : totalLost >= 25 ? 'medium' : kept.length ? 'low' : 'info'
  return {
    id: 'ctr-anomaly',
    title: 'CTR anomalies',
    severity,
    summary: {
      delta: -totalLost,
      direction: totalLost > 0 ? 'down' : 'flat',
      magnitudeLabel: `${Math.round(totalLost)} clicks lost vs baseline`,
    },
    findings,
    truncated: truncation(rows.length, kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'ctr-anomaly'),
  }
}

interface ChangePointRow {
  keyword: string
  page: string
  changeDate: string
  delta: number
  llr: number
  direction: 'improved' | 'worsened'
}

function buildChangePointSection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<ChangePointRow>(res)
    .filter(r => r.direction === 'worsened')
    .sort((a, b) => b.llr - a.llr)
  const kept = rows.slice(0, max)

  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.keyword },
    metrics: { llr: r.llr, delta: r.delta },
    why: `worsened on ${r.changeDate}${r.page ? ` (${r.page})` : ''}`,
  }))

  return {
    id: 'change-point',
    title: 'Change-points (worsening)',
    severity: kept.length ? 'medium' : 'info',
    summary: { magnitudeLabel: `${kept.length} worsening segments` },
    findings,
    truncated: truncation(rows.length, kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'change-point'),
  }
}

interface PositionVolatilityRow {
  page: string
  avgVolatility: number
  peakVolatility: number
  totalImpressions: number
}

function buildPositionVolatilitySection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<PositionVolatilityRow>(res)
    .sort((a, b) => b.peakVolatility - a.peakVolatility)
  const kept = rows.slice(0, max)

  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'page', value: r.page },
    metrics: {
      avgVolatility: r.avgVolatility,
      peakVolatility: r.peakVolatility,
      impressions: r.totalImpressions,
    },
  }))

  return {
    id: 'position-volatility',
    title: 'Position volatility',
    severity: kept.length ? 'low' : 'info',
    summary: {},
    findings,
    truncated: truncation(rows.length, kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'position-volatility'),
  }
}
