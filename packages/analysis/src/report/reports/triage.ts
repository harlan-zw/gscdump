/**
 * `triage <page|query>` — focused investigation report. Runs the diagnostic
 * triumvirate (change-point, query-migration, position-volatility) against
 * the full site, then filters to the target entity in `reduce()`.
 *
 * v1 scope strategy: filter post-hoc rather than push the predicate into
 * each analyzer's `build()`. `triage` is a low-volume, agent-facing report;
 * the cost of running these three analyzers full-site once is bearable
 * compared to the contract churn of teaching every analyzer about scoping.
 * Phase 9+ can introduce target-aware plans if the cost shows up.
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection } from '@gscdump/engine/report'
import type { ResolveTargetKind } from '../resolve-target'
import { defineReport } from '@gscdump/engine/report'
import { requireReportParam } from '../require'
import { resolveTarget } from '../resolve-target'

export interface TriageReportParams {
  /** `'page'` or `'query'`. Default `'page'`. */
  targetKind?: ResolveTargetKind
  /** Page URL or query string to triage. Required. */
  target?: string
  maxFindings?: number
}

const DEFAULT_MAX = 10

export const triageReport = defineReport<TriageReportParams>({
  id: 'triage',
  description: 'Focused investigation: change-points, query migration, and position volatility scoped to one page or query.',
  defaultPeriod: 'last-90d',
  defaultComparison: 'none',
  argsSpec: {
    'target': { type: 'string', description: 'Target page URL or query string', required: true },
    'target-kind': { type: 'string', description: 'page | query', default: 'page' },
    'max-findings': { type: 'number', description: 'Cap findings per section', default: DEFAULT_MAX },
  },
  plan: (params, window) => {
    requireReportParam('triage', 'target', params.target, 'triage report requires --target <page-or-query>')
    const dates = { startDate: window.start, endDate: window.end }
    return [
      { key: 'change-point', type: 'change-point', params: { ...dates, limit: 200 } },
      { key: 'query-migration', type: 'query-migration', params: { ...dates, limit: 200 } },
      { key: 'position-volatility', type: 'position-volatility', params: { ...dates, limit: 200 } },
    ]
  },
  reduce: (results, ctx) => {
    const target = ctx.params.target!
    const kind = ctx.params.targetKind ?? 'page'
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    const resolved = resolveTarget({ kind, input: target })
    const needle = (resolved.exact ?? target).toLowerCase()
    const matches = (val: string): boolean => val.toLowerCase().includes(needle)

    return {
      sections: [
        buildChangePointSection(results['change-point'], kind, matches, max),
        buildMigrationSection(results['query-migration'], kind, matches, max, target),
        buildVolatilitySection(results['position-volatility'], kind, matches, max),
      ],
    }
  },
})

interface ChangePointRow {
  keyword: string
  page: string
  changeDate: string
  delta: number
  llr: number
  direction: 'improved' | 'worsened'
}

function buildChangePointSection(
  res: AnalysisResult | undefined,
  kind: ResolveTargetKind,
  matches: (val: string) => boolean,
  max: number,
): ReportSection {
  const rows = ((res?.results ?? []) as unknown as ChangePointRow[])
    .filter(r => matches(kind === 'page' ? r.page : r.keyword))
    .sort((a, b) => b.llr - a.llr)
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: kind === 'page' ? 'page' : 'query', value: kind === 'page' ? r.page : r.keyword },
    metrics: { llr: r.llr, delta: r.delta },
    why: `${r.direction} on ${r.changeDate}`,
  }))
  return {
    id: 'change-point',
    title: 'Change-points',
    severity: kept.length ? 'medium' : 'info',
    summary: { magnitudeLabel: `${kept.length} change-point${kept.length === 1 ? '' : 's'}` },
    findings,
    truncated: rows.length > max ? { kept: kept.length, total: rows.length } : undefined,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'change-point', params: { type: 'change-point' } } : undefined,
  }
}

interface MigrationRow {
  sourcePage: string
  targetPage: string
  weight: number
  queryCount: number
}

function buildMigrationSection(
  res: AnalysisResult | undefined,
  kind: ResolveTargetKind,
  matches: (val: string) => boolean,
  max: number,
  _rawTarget: string,
): ReportSection {
  const rows = ((res?.results ?? []) as unknown as MigrationRow[])
    // For pages, match either side of the migration; query-mode this section
    // is N/A so it'll filter to empty (still useful as artifact pointer).
    .filter(r => kind === 'page' ? (matches(r.sourcePage) || matches(r.targetPage)) : false)
    .sort((a, b) => b.weight - a.weight)
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'page', value: r.targetPage },
    metrics: { weight: r.weight, queryCount: r.queryCount },
    why: `from ${r.sourcePage}`,
  }))
  return {
    id: 'query-migration',
    title: 'Query migration',
    severity: 'info',
    summary: { magnitudeLabel: kind === 'page' ? `${kept.length} migration edges touching target` : 'N/A for query target' },
    findings,
    truncated: rows.length > max ? { kept: kept.length, total: rows.length } : undefined,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'query-migration', params: { type: 'query-migration' } } : undefined,
  }
}

interface VolatilityRow {
  page: string
  avgVolatility: number
  peakVolatility: number
  totalImpressions: number
}

function buildVolatilitySection(
  res: AnalysisResult | undefined,
  kind: ResolveTargetKind,
  matches: (val: string) => boolean,
  max: number,
): ReportSection {
  const rows = kind === 'page'
    ? ((res?.results ?? []) as unknown as VolatilityRow[]).filter(r => matches(r.page))
    : []
  const sorted = rows.sort((a, b) => b.peakVolatility - a.peakVolatility)
  const kept = sorted.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'page', value: r.page },
    metrics: { avgVolatility: r.avgVolatility, peakVolatility: r.peakVolatility, impressions: r.totalImpressions },
  }))
  return {
    id: 'position-volatility',
    title: 'Position volatility',
    severity: kept.length ? 'low' : 'info',
    summary: { magnitudeLabel: kind === 'page' ? `${kept.length} volatile day${kept.length === 1 ? '' : 's'}` : 'N/A for query target' },
    findings,
    truncated: rows.length > max ? { kept: kept.length, total: rows.length } : undefined,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'position-volatility', params: { type: 'position-volatility' } } : undefined,
  }
}
