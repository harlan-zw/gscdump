// The actionable issue rows of one indexing reading.
//
// Ported from nuxtseo.com `layers/pro/gsc/shared/site-indexing-issues.ts`.
// request-indexing holds the same rules in its own copy.
//
// Only rows a user can act on. The "Expected behaviour" group in
// `./indexing-issues` (noindex, redirect, alternate canonical) is absent on
// purpose: a row that offers to fix an intentional redirect is noise.

import type { IndexingTrendReading } from './readings'

export type SiteIndexingIssuePoint = Pick<IndexingTrendReading, 'issues' | 'coverage' | 'signals'>

export interface SiteIndexingIssue {
  /** Kebab-case row id, such as `crawled-not-indexed`. */
  id: string
  label: string
  count: number
  /** The URLs list filter that shows this row's URLs. */
  filter: { key: 'issue' | 'facet', value: string }
}

interface IssueSpec extends Omit<SiteIndexingIssue, 'count'> {
  /** Sort rank: 0 is an actionable failure, 1 needs attention. Ties break on count. */
  rank: number
  pick: (point: SiteIndexingIssuePoint) => number | undefined
}

const ISSUE_SPECS: readonly IssueSpec[] = [
  { id: 'server-error', label: 'Server error', rank: 0, pick: p => p.issues?.serverError, filter: { key: 'issue', value: 'server_error' } },
  { id: 'not-found', label: 'Not found', rank: 0, pick: p => p.issues?.notFound, filter: { key: 'issue', value: 'not_found' } },
  { id: 'soft-404', label: 'Soft 404', rank: 0, pick: p => p.issues?.soft404, filter: { key: 'issue', value: 'soft_404' } },
  { id: 'crawled-not-indexed', label: 'Crawled, not indexed', rank: 0, pick: p => p.coverage?.crawledNotIndexed, filter: { key: 'issue', value: 'crawled_not_indexed' } },
  { id: 'discovered-not-indexed', label: 'Discovered, not crawled', rank: 1, pick: p => p.coverage?.discoveredNotCrawled, filter: { key: 'issue', value: 'discovered_not_indexed' } },
  { id: 'blocked-robots', label: 'Blocked by robots.txt', rank: 1, pick: p => p.issues?.blockedByRobots, filter: { key: 'issue', value: 'blocked_robots' } },
  { id: 'rich-results', label: 'Rich result errors', rank: 1, pick: p => p.signals?.richResultsFail, filter: { key: 'facet', value: 'rich_results' } },
]

/** The positive-count issue rows of one reading: failures first, then larger counts. */
export function getSiteIndexingIssues(point: SiteIndexingIssuePoint | null | undefined): SiteIndexingIssue[] {
  if (!point)
    return []

  return ISSUE_SPECS
    .map(spec => ({ ...spec, count: spec.pick(point) ?? 0 }))
    .filter(issue => issue.count > 0)
    .sort((a, b) => a.rank - b.rank || b.count - a.count)
    .map(({ id, label, count, filter }) => ({ id, label, count, filter }))
}
