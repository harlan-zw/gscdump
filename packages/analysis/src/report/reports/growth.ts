/**
 * `growth` report — long-window strategic view (default 90d vs YoY).
 * Composes content-velocity (new keywords over time), keyword-breadth
 * (histogram of pages by query count), intent-atlas (cluster overview),
 * and long-tail (page query-distribution shape).
 *
 * v1 entity-model limitation: content-velocity / keyword-breadth /
 * intent-atlas are NOT page-or-query keyed (they're week / bucket / cluster
 * keyed). Their sections leave `findings: []` and surface aggregates via
 * `summary.magnitudeLabel`; consumers wanting the raw shape should follow
 * `artifact.analyzer`. Long-tail is page-keyed, so its section has
 * findings.
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'

export interface GrowthReportParams {
  maxFindings?: number
}

const DEFAULT_MAX = 5

export const growthReport = defineReport<GrowthReportParams>({
  id: 'growth',
  description: 'Strategic growth signals: content velocity, keyword breadth, intent atlas, and long-tail shape over a long window (default 90d / YoY).',
  defaultPeriod: 'last-90d',
  defaultComparison: 'yoy',
  argsSpec: {
    'max-findings': { type: 'number', description: 'Cap findings per section (long-tail only)', default: DEFAULT_MAX },
  },
  plan: (_params, window) => {
    const dates = { startDate: window.start, endDate: window.end }
    return [
      { key: 'content-velocity', type: 'content-velocity', params: { ...dates, days: window.days, limit: 200 } },
      { key: 'keyword-breadth', type: 'keyword-breadth', params: { ...dates, limit: 50 } },
      { key: 'intent-atlas', type: 'intent-atlas', params: { ...dates, limit: 50 } },
      { key: 'long-tail', type: 'long-tail', params: { ...dates, limit: 100 } },
    ]
  },
  reduce: (results, ctx) => {
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    return {
      sections: [
        buildContentVelocity(results['content-velocity']),
        buildKeywordBreadth(results['keyword-breadth']),
        buildIntentAtlas(results['intent-atlas']),
        buildLongTail(results['long-tail'], max),
      ],
    }
  },
})

interface ContentVelocityRow {
  week: string
  newKeywords: number
  totalKeywords: number
}

function buildContentVelocity(res: AnalysisResult | undefined): ReportSection {
  const rows = (res?.results ?? []) as unknown as ContentVelocityRow[]
  const totalNew = rows.reduce((s, r) => s + r.newKeywords, 0)
  const avgPerWeek = rows.length > 0 ? totalNew / rows.length : 0
  return {
    id: 'content-velocity',
    title: 'Content velocity',
    severity: 'info',
    summary: { magnitudeLabel: `${totalNew} new keywords across ${rows.length} weeks (avg ${avgPerWeek.toFixed(1)}/wk)` },
    findings: [],
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'content-velocity', params: { type: 'content-velocity' } } : undefined,
  }
}

interface KeywordBreadthRow {
  bucket: string
  pageCount: number
}

function buildKeywordBreadth(res: AnalysisResult | undefined): ReportSection {
  const rows = (res?.results ?? []) as unknown as KeywordBreadthRow[]
  const totalPages = rows.reduce((s, r) => s + r.pageCount, 0)
  const top = rows[0]
  return {
    id: 'keyword-breadth',
    title: 'Keyword breadth',
    severity: 'info',
    summary: { magnitudeLabel: top ? `${totalPages} pages; modal bucket "${top.bucket}" (${top.pageCount} pages)` : 'no data' },
    findings: [],
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'keyword-breadth', params: { type: 'keyword-breadth' } } : undefined,
  }
}

interface IntentAtlasRow {
  clusterKey: string
  keywordCount: number
  totalImpressions: number
  totalClicks: number
  ctr: number
  avgPosition: number
}

function buildIntentAtlas(res: AnalysisResult | undefined): ReportSection {
  const rows = (res?.results ?? []) as unknown as IntentAtlasRow[]
  const totalClusters = rows.length
  const totalKeywords = rows.reduce((s, r) => s + r.keywordCount, 0)
  return {
    id: 'intent-atlas',
    title: 'Intent atlas',
    severity: 'info',
    summary: { magnitudeLabel: `${totalClusters} clusters covering ${totalKeywords} keywords` },
    findings: [],
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'intent-atlas', params: { type: 'intent-atlas' } } : undefined,
  }
}

interface LongTailRow {
  page: string
  queryCount: number
  totalImpressions: number
  totalClicks: number
  headShare: number
  fingerprint: 'flat-tail' | 'balanced' | 'head-heavy'
}

function buildLongTail(res: AnalysisResult | undefined, max: number): ReportSection {
  const rows = ((res?.results ?? []) as unknown as LongTailRow[])
    // Surface head-heavy pages first — most fragile / most concentrated.
    .sort((a, b) => {
      const rank: Record<LongTailRow['fingerprint'], number> = { 'head-heavy': 0, 'balanced': 1, 'flat-tail': 2 }
      const dr = rank[a.fingerprint] - rank[b.fingerprint]
      return dr !== 0 ? dr : b.headShare - a.headShare
    })
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'page', value: r.page },
    metrics: {
      queryCount: r.queryCount,
      impressions: r.totalImpressions,
      headShare: r.headShare,
    },
    why: `${r.fingerprint} (${(r.headShare * 100).toFixed(0)}% head share)`,
  }))
  const headHeavy = rows.filter(r => r.fingerprint === 'head-heavy').length
  return {
    id: 'long-tail',
    title: 'Long-tail shape',
    severity: headHeavy > rows.length / 3 ? 'medium' : 'info',
    summary: { magnitudeLabel: `${rows.length} pages analysed; ${headHeavy} head-heavy` },
    findings,
    truncated: rows.length > max ? { kept: kept.length, total: rows.length } : undefined,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'long-tail', params: { type: 'long-tail' } } : undefined,
  }
}
