/**
 * `priority` report — composes five analyzer signals (striking-distance,
 * opportunity, cannibalization, ctr-anomaly, change-point) into a single
 * ranked "priority actions" section. Replaces the deleted
 * `analyzeActionPriority` orchestration entry-point; reuses the same
 * scoring/merging primitives from `action-priority.ts`.
 */

import type { AnalysisResult } from '@gscdump/engine/analysis-types'
import type { ReportAction, ReportFinding, ReportSection } from '@gscdump/engine/report'
import type { ActionSource, PriorityAction } from '../../action-priority'
import { defineReport } from '@gscdump/engine/report'
import {

  DEFAULT_PRIORITY_SOURCES,
  mergePriorityActions,
  normalizePriorityActions,

  scorePriorityActions,
} from '../../action-priority'

export interface PriorityReportParams {
  /** Cap actions surfaced in the section. Default 40. */
  limit?: number
  /** Cap top-N actions echoed as `ReportAction[]`. Default 10. */
  maxActions?: number
}

const DEFAULT_LIMIT = 40
const DEFAULT_ACTIONS = 10

export const priorityReport = defineReport<PriorityReportParams>({
  id: 'priority',
  description: 'Ranked priority actions composed from striking-distance, opportunity, cannibalization, ctr-anomaly, and change-point signals.',
  defaultPeriod: 'last-28d',
  defaultComparison: 'prev-period',
  argsSpec: {
    'limit': { type: 'number', description: 'Max actions in the section', default: DEFAULT_LIMIT },
    'max-actions': { type: 'number', description: 'Top-N rendered as ReportAction', default: DEFAULT_ACTIONS },
  },
  plan: (_params, window) => {
    const dates = { startDate: window.start, endDate: window.end }
    const cmp = window.comparison
      ? { prevStartDate: window.comparison.start, prevEndDate: window.comparison.end }
      : {}
    return DEFAULT_PRIORITY_SOURCES.map(source => ({
      key: source,
      type: source,
      params: { ...dates, ...cmp, limit: 100 },
      // None individually required: action-priority's contract has always been
      // "best effort across signals". Section coverage flips to 'partial' if
      // any analyzer errors.
      required: false,
    }))
  },
  reduce: (results, ctx) => {
    const limit = ctx.params.limit ?? DEFAULT_LIMIT
    const maxActions = ctx.params.maxActions ?? DEFAULT_ACTIONS

    const all: PriorityAction[] = []
    let anyMissing = false
    for (const source of DEFAULT_PRIORITY_SOURCES) {
      const r = results[source] as AnalysisResult | undefined
      if (!r) {
        anyMissing = true
        continue
      }
      all.push(...normalizePriorityActions(source as ActionSource, r))
    }

    const ranked = scorePriorityActions(mergePriorityActions(all)).slice(0, limit)

    const findings: ReportFinding[] = ranked.map(a => ({
      entity: { kind: 'query', value: a.keyword },
      metrics: {
        priorityScore: a.priorityScore,
        severity: a.severity,
        impact: a.impact,
        impressions: a.impressions,
      },
      why: `${a.title} — ${a.why} (page: ${a.page})`,
    }))

    const actions: ReportAction[] = ranked.slice(0, maxActions).map((a) => {
      const primarySource = a.sources[0]!
      return {
        kind: primarySource === 'cannibalization' ? 'fix' : 'analyzer',
        target: { kind: 'page', value: a.page },
        params: { type: primarySource },
        rationale: a.title,
      }
    })

    const topSeverity = ranked[0]?.severity ?? 0
    const section: ReportSection = {
      id: 'priority',
      title: 'Priority actions',
      severity: topSeverity >= 70 ? 'high' : topSeverity >= 40 ? 'medium' : ranked.length ? 'low' : 'info',
      summary: { magnitudeLabel: `${ranked.length} actions ranked` },
      findings,
      truncated: all.length > ranked.length ? { kept: ranked.length, total: all.length } : undefined,
      coverage: anyMissing ? 'partial' : 'full',
      actions,
    }

    return { sections: [section] }
  },
})
