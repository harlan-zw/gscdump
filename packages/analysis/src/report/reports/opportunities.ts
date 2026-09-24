/**
 * `opportunities` report — surfaces queries we could win cheaply: striking
 * distance (positions 4–20), opportunity-score winners, zero-click queries,
 * and queries migrating between pages.
 *
 * No comparison required; default 28d.
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'
import { reportRows, resultTotal, sectionArtifact, sectionCoverage, truncation } from '../sections'

export interface OpportunitiesReportParams {
  maxFindings?: number
}

const DEFAULT_MAX = 5

export const opportunitiesReport = defineReport<OpportunitiesReportParams>({
  id: 'opportunities',
  description: 'Striking-distance, low-CTR, zero-click, and query-migration opportunities.',
  defaultPeriod: 'last-28d',
  defaultComparison: 'none',
  argsSpec: {
    'max-findings': { type: 'number', description: 'Cap findings per section', default: DEFAULT_MAX },
  },
  plan: (_params, window) => {
    const dates = { startDate: window.start, endDate: window.end }
    return [
      { key: 'striking', type: 'striking-distance', params: { ...dates, limit: 100 }, required: true, feeds: ['striking-distance'] },
      { key: 'opportunity', type: 'opportunity', params: { ...dates, limit: 100 }, feeds: ['low-ctr'] },
      { key: 'zero-click', type: 'zero-click', params: { ...dates, limit: 100 } },
      { key: 'query-migration', type: 'query-migration', params: { ...dates, limit: 50 } },
    ]
  },
  reduce: (results, ctx) => {
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    return {
      sections: [
        buildStrikingSection(results.striking, max),
        buildOpportunitySection(results.opportunity, max),
        buildZeroClickSection(results['zero-click'], max),
        buildMigrationSection(results['query-migration'], max),
      ],
    }
  },
})

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
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.keyword },
    metrics: { position: r.position, impressions: r.impressions, clicks: r.clicks, potentialClicks: r.potentialClicks },
    why: r.page ? `on ${r.page}` : undefined,
  }))
  const totalPotential = kept.reduce((s, r) => s + r.potentialClicks, 0)
  return {
    id: 'striking-distance',
    title: 'Striking distance',
    severity: 'low',
    summary: { magnitudeLabel: `${Math.round(totalPotential)} potential clicks` },
    findings,
    truncated: truncation(resultTotal(res, rows.length), kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'striking-distance'),
  }
}

interface OpportunityRow {
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  opportunityScore: number
  potentialClicks: number
}

function buildOpportunitySection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<OpportunityRow>(res)
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.keyword },
    metrics: {
      opportunityScore: r.opportunityScore,
      ctr: r.ctr,
      position: r.position,
      impressions: r.impressions,
      potentialClicks: r.potentialClicks,
    },
    why: r.page ? `low CTR on ${r.page}` : 'low CTR vs position',
  }))
  return {
    id: 'low-ctr',
    title: 'Underperforming CTR',
    severity: 'low',
    summary: {},
    findings,
    truncated: truncation(resultTotal(res, rows.length), kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'opportunity'),
  }
}

interface ZeroClickRow {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/**
 * The analyzer flags low CTR at a top position, not zero clicks. Say that,
 * with the real numbers, so a row with clicks never reads as "0 clicks".
 */
function zeroClickWhy(r: ZeroClickRow): string {
  const ctr = `${(r.ctr * 100).toFixed(1)}% CTR`
  return `${ctr} at position ${r.position.toFixed(1)} on ${r.page}`
}

function buildZeroClickSection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<ZeroClickRow>(res)
    .sort((a, b) => b.impressions - a.impressions)
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.query },
    metrics: { impressions: r.impressions, clicks: r.clicks, position: r.position, ctr: r.ctr },
    why: zeroClickWhy(r),
  }))
  return {
    id: 'zero-click',
    title: 'Zero-click queries',
    severity: 'info',
    summary: { magnitudeLabel: `${kept.reduce((s, r) => s + r.impressions, 0)} impressions at low CTR` },
    findings,
    truncated: truncation(resultTotal(res, rows.length), kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'zero-click'),
  }
}

interface MigrationRow {
  sourcePage: string
  targetPage: string
  weight: number
  queryCount: number
}

function buildMigrationSection(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = reportRows<MigrationRow>(res)
    .sort((a, b) => b.weight - a.weight)
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'page', value: r.targetPage },
    metrics: { weight: r.weight, queryCount: r.queryCount },
    why: `migrating from ${r.sourcePage}`,
  }))
  return {
    id: 'query-migration',
    title: 'Query migration',
    severity: 'info',
    summary: {},
    findings,
    truncated: truncation(resultTotal(res, rows.length), kept.length),
    coverage: sectionCoverage(res),
    artifact: sectionArtifact(res, 'query-migration'),
  }
}
