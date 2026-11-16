// The Regression lead: previously indexed URLs under one Index cohort's path
// whose URL Inspection verdict changed away from PASS.
//
// Ported from nuxtseo.com `layers/pro/gsc/shared/indexing-transition-lead.ts`.
// request-indexing holds the same copy. gscdump.com reads a Site-wide variant.
//
// URL Inspection samples bound the change window. The window runs from the
// earliest `changedAfter` to the latest `changedBefore`. It does not date the
// exact change.

import type { PartnerIndexingTransitionsV1Response } from '@gscdump/contracts/v1/http'
import type { IndexCohortCell } from './cohorts'

/** One recorded transition, as the hosted transitions read returns it. */
export type IndexingTransitionRow = Pick<
  PartnerIndexingTransitionsV1Response['data']['transitions'][number],
  'url' | 'fromValue' | 'toValue' | 'changedAfter' | 'changedBefore'
> & {
  /** One of `GSCDUMP_INDEXING_TRANSITION_FIELDS`. Only `indexStatus` rows count. */
  field: string
}

export type IndexingRegressionLead
  = | {
    _tag: 'lead'
    /** Distinct URLs whose verdict changed away from PASS. */
    count: number
    title: string
    detail: string
    /** The earliest `changedAfter`, as ISO. */
    start: string
    /** The latest `changedBefore`, as ISO. */
    end: string
  }
  | {
    _tag: 'none'
    reason: 'cohort-has-no-path' | 'no-index-regression'
  }

function pathBelongsTo(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`)
}

function transitionTime(value: string): number | null {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

const transitionDateFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
})

export function selectIndexingRegressionLead(
  cohort: Pick<IndexCohortCell, 'label' | 'pathPrefix'>,
  transitions: readonly IndexingTransitionRow[],
): IndexingRegressionLead {
  const prefix = cohort.pathPrefix
  if (!prefix)
    return { _tag: 'none', reason: 'cohort-has-no-path' }

  const regressions = transitions.flatMap((transition) => {
    if (
      transition.field !== 'indexStatus'
      || transition.fromValue !== 'PASS'
      || transition.toValue === 'PASS'
      || !URL.canParse(transition.url)
    ) {
      return []
    }
    const start = transitionTime(transition.changedAfter)
    const end = transitionTime(transition.changedBefore)
    if (start === null || end === null || end < start)
      return []
    if (!pathBelongsTo(new URL(transition.url).pathname, prefix))
      return []
    return [{ ...transition, end, start }]
  })

  if (!regressions.length)
    return { _tag: 'none', reason: 'no-index-regression' }

  const count = new Set(regressions.map(transition => transition.url)).size
  const first = regressions.reduce((earliest, transition) => transition.start < earliest.start ? transition : earliest)
  const last = regressions.reduce((latest, transition) => transition.end > latest.end ? transition : latest)

  return {
    _tag: 'lead',
    count,
    detail: 'URL Inspection samples bound the change window; they do not identify the exact drop time.',
    end: last.changedBefore,
    start: first.changedAfter,
    title: `Google dropped ${count.toLocaleString('en-US')} ${count === 1 ? 'page' : 'pages'} in ${cohort.label} between ${transitionDateFormat.format(new Date(first.changedAfter))} and ${transitionDateFormat.format(new Date(last.changedBefore))}.`,
  }
}
