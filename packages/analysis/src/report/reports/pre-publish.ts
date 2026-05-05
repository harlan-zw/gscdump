/**
 * `pre-publish <topic|url>` — pre-publish guard. Runs cannibalization and
 * striking-distance against the full site, surfaces only entries whose
 * keyword/page touches the candidate topic. Intent: catch "are we already
 * targeting this?" and "are we close to ranking?" before shipping new
 * content.
 *
 * v1 same scoping strategy as `triage`: post-hoc filter, no analyzer
 * contract changes.
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportFinding, ReportSection } from '@gscdump/engine/report'
import { defineReport } from '@gscdump/engine/report'

export interface PrePublishReportParams {
  /** The topic / keyword phrase or URL slug to check before publishing. Required. */
  topic?: string
  maxFindings?: number
}

const DEFAULT_MAX = 10

export const prePublishReport = defineReport<PrePublishReportParams>({
  id: 'pre-publish',
  description: 'Pre-publish guard: cannibalization risk and striking-distance peers for a candidate topic or URL.',
  defaultPeriod: 'last-90d',
  defaultComparison: 'none',
  argsSpec: {
    'topic': { type: 'string', description: 'Topic / keyword / URL slug to check', required: true },
    'max-findings': { type: 'number', description: 'Cap findings per section', default: DEFAULT_MAX },
  },
  plan: (params, window) => {
    if (!params.topic)
      throw new Error('pre-publish report requires --topic <topic-or-url>')
    const dates = { startDate: window.start, endDate: window.end }
    return [
      { key: 'cannibalization', type: 'cannibalization', params: { ...dates, limit: 200 } },
      { key: 'striking', type: 'striking-distance', params: { ...dates, limit: 200 } },
    ]
  },
  reduce: (results, ctx) => {
    const topic = (ctx.params.topic ?? '').trim().toLowerCase()
    const max = ctx.params.maxFindings ?? DEFAULT_MAX
    const matches = (val: string | null | undefined): boolean => !!val && val.toLowerCase().includes(topic)

    return {
      sections: [
        buildCannibalizationSection(results.cannibalization, matches, max),
        buildStrikingPeersSection(results.striking, matches, max, topic),
      ],
    }
  },
})

interface CannibalizationRow {
  keyword: string
  totalClicks: number
  totalImpressions: number
  competitorCount: number
  competitors: { url: string }[]
}

function buildCannibalizationSection(
  res: AnalysisResult | undefined,
  matches: (val: string | null | undefined) => boolean,
  max: number,
): ReportSection {
  const rows = ((res?.results ?? []) as unknown as CannibalizationRow[])
    .filter(r => matches(r.keyword) || (r.competitors ?? []).some(p => matches(p.url)))
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
      why: `${pageCount} page(s) already targeting`,
    }
  })
  return {
    id: 'cannibalization-risk',
    title: 'Cannibalization risk',
    severity: kept.length ? 'high' : 'info',
    summary: { magnitudeLabel: kept.length ? `${kept.length} existing competition` : 'no existing competition' },
    findings,
    truncated: rows.length > max ? { kept: kept.length, total: rows.length } : undefined,
    coverage: res ? 'full' : 'partial',
    actions: kept.slice(0, 1).map(() => ({
      kind: 'fix',
      rationale: 'Decide before publishing: redirect existing page, target a different angle, or accept overlap.',
    })),
    artifact: res ? { analyzer: 'cannibalization', params: { type: 'cannibalization' } } : undefined,
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

function buildStrikingPeersSection(
  res: AnalysisResult | undefined,
  matches: (val: string | null | undefined) => boolean,
  max: number,
  topic: string,
): ReportSection {
  const rows = ((res?.results ?? []) as unknown as StrikingRow[])
    .filter(r => matches(r.keyword) || matches(r.page))
    .sort((a, b) => b.potentialClicks - a.potentialClicks)
  const kept = rows.slice(0, max)
  const findings: ReportFinding[] = kept.map(r => ({
    entity: { kind: 'query', value: r.keyword },
    metrics: { position: r.position, impressions: r.impressions, potentialClicks: r.potentialClicks },
    why: r.page ? `currently on ${r.page}` : undefined,
  }))
  return {
    id: 'striking-peers',
    title: 'Existing striking-distance peers',
    severity: kept.length ? 'low' : 'info',
    summary: { magnitudeLabel: kept.length ? `${kept.length} adjacent rankings for "${topic}"` : 'no adjacent rankings' },
    findings,
    truncated: rows.length > max ? { kept: kept.length, total: rows.length } : undefined,
    coverage: res ? 'full' : 'partial',
    actions: [],
    artifact: res ? { analyzer: 'striking-distance', params: { type: 'striking-distance' } } : undefined,
  }
}
