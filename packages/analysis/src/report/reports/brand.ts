/**
 * `brand` report — brand vs non-brand split + concentration overview.
 * Requires `--brand-terms` (comma-separated). Default 28d / none.
 *
 * v1 limitation: the concentration step runs site-wide on keywords (no
 * brand-aware filter exists in the analyzer yet). It still surfaces useful
 * top-N + risk-level info; the section title is explicit about scope.
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'
import { requireReportParam } from '../require'

export interface BrandReportParams {
  /** Comma-separated brand terms. Required. */
  brandTerms?: string
  maxFindings?: number
}

const DEFAULT_MAX = 5

export const brandReport = defineReport<BrandReportParams>({
  id: 'brand',
  description: 'Brand vs non-brand share, top brand keywords, and site-wide keyword concentration.',
  defaultPeriod: 'last-28d',
  defaultComparison: 'none',
  argsSpec: {
    'brand-terms': { type: 'string', description: 'Comma-separated brand terms', required: true },
    'max-findings': { type: 'number', description: 'Cap findings per section', default: DEFAULT_MAX },
  },
  plan: (params, window) => {
    const rawBrandTerms = requireReportParam('brand', 'brand-terms', params.brandTerms, 'brand report requires --brand-terms <comma,separated,list>')
    const brandTerms = rawBrandTerms.split(',').map(t => t.trim()).filter(Boolean)
    const dates = { startDate: window.start, endDate: window.end }
    return [
      { key: 'brand', type: 'brand', params: { ...dates, brandTerms, limit: 200 }, required: true },
      { key: 'concentration', type: 'concentration', params: { ...dates, dimension: 'keywords', limit: 50 } },
    ]
  },
  reduce: (results, ctx) => {
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    return {
      sections: [
        buildBrandSplitSection(results.brand, max),
        buildConcentrationSection(results.concentration, max),
      ],
    }
  },
})

interface BrandRow {
  query: string
  page?: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  segment: 'brand' | 'non-brand'
}

interface BrandSummary {
  brandClicks: number
  nonBrandClicks: number
  brandShare: number
  brandImpressions: number
  nonBrandImpressions: number
}

function buildBrandSplitSection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = (res?.results ?? []) as unknown as BrandRow[]
  const summary = res?.meta?.summary as BrandSummary | undefined
  const brandKws = rows.filter(r => r.segment === 'brand').sort((a, b) => b.clicks - a.clicks).slice(0, max)
  const findings: ReportFinding[] = brandKws.map(r => ({
    entity: { kind: 'query', value: r.query },
    metrics: { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position },
    why: r.page ? `on ${r.page}` : undefined,
  }))

  const brandShare = summary?.brandShare ?? 0
  const magnitudeLabel = summary
    ? `brand share ${(brandShare * 100).toFixed(1)}% (${summary.brandClicks} brand vs ${summary.nonBrandClicks} non-brand clicks)`
    : 'no summary available'

  return {
    id: 'brand-split',
    title: 'Brand vs non-brand',
    severity: 'info',
    summary: { magnitudeLabel },
    findings,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'brand', params: { type: 'brand' } } : undefined,
  }
}

interface ConcentrationItemLocal {
  key: string
  clicks: number
  share: number
}

interface ConcentrationResult {
  giniCoefficient: number
  hhi: number
  topNConcentration: number
  topNItems: ConcentrationItemLocal[]
  totalItems: number
  totalClicks: number
  riskLevel: 'low' | 'medium' | 'high'
}

function buildConcentrationSection(res: AnalysisResult | undefined, max: number): ReportSection {
  // concentration analyzer returns a single-row result list (per call).
  const rows = (res?.results ?? []) as unknown as ConcentrationResult[]
  const head = rows[0]
  const top = (head?.topNItems ?? []).slice(0, max)
  const findings: ReportFinding[] = top.map(it => ({
    entity: { kind: 'query', value: it.key },
    metrics: { clicks: it.clicks, share: it.share },
  }))
  const severity = head?.riskLevel === 'high' ? 'high' : head?.riskLevel === 'medium' ? 'medium' : 'low'
  return {
    id: 'concentration',
    title: 'Keyword concentration (site-wide)',
    severity: head ? severity : 'info',
    summary: head
      ? { magnitudeLabel: `HHI ${head.hhi.toFixed(0)} (${head.riskLevel}); top-N share ${(head.topNConcentration * 100).toFixed(1)}%` }
      : {},
    findings,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'concentration', params: { type: 'concentration', dimension: 'keywords' } } : undefined,
  }
}
