// Google's URL Inspection `coverageState` prose, parsed into one tag.
//
// The tags live in `@gscdump/contracts` (`COVERAGE_STATE_TAGS`). This module owns
// the prose table, so the JS parser and the SQL expression below read the same
// strings and cannot drift. Match exactly: a `LIKE '%not indexed%'` pattern once
// counted "Discovered - currently not indexed" as crawled.

import type { CoverageStateCounts, CoverageStateTag, VerdictFreshness } from '@gscdump/contracts'

type MappedCoverageStateTag = Exclude<CoverageStateTag, 'unrecognized' | 'not_reported'>

/**
 * Parsed coverage state for one URL Inspection result.
 *
 * - A mapped tag: Google's prose names one known state.
 * - `unrecognized`: Google returned prose no tag maps. `coverageState` keeps it.
 * - `not_reported`: the result carried no coverage prose.
 */
export type CoverageState
  = | { _tag: MappedCoverageStateTag }
    | { _tag: 'unrecognized', coverageState: string }
    | { _tag: 'not_reported' }

/**
 * Every coverage prose string Google returns, by tag. Two spellings exist for the
 * noindex exclusion: the URL Inspection API uses typographic quotes, and the Page
 * indexing report uses straight quotes.
 */
export const GOOGLE_COVERAGE_STATES = {
  unknown_to_google: ['URL is unknown to Google'],
  discovered_not_indexed: ['Discovered - currently not indexed'],
  crawled_not_indexed: ['Crawled - currently not indexed'],
  indexed: [
    'Submitted and indexed',
    'Indexed, not submitted in sitemap',
    'Indexed, though blocked by robots.txt',
    'Indexed; consider marking as canonical',
    'Page indexed without content',
  ],
  noindex: ['Excluded by ‘noindex’ tag', 'Excluded by \'noindex\' tag'],
  blocked_robots: ['Blocked by robots.txt'],
  soft_404: ['Soft 404'],
  not_found: ['Not found (404)'],
  server_error: ['Server error (5xx)'],
  access_denied: ['Blocked due to unauthorized request (401)'],
  access_forbidden: ['Blocked due to access forbidden (403)'],
  blocked_4xx: ['Blocked due to other 4xx issue'],
  redirect: ['Page with redirect'],
  redirect_error: ['Redirect error'],
  alternate_canonical: ['Alternate page with proper canonical tag'],
  duplicate_no_canonical: ['Duplicate without user-selected canonical'],
  duplicate_google_canonical: ['Duplicate, Google chose different canonical than user'],
  page_removed: ['Blocked by page removal tool'],
} as const satisfies Record<MappedCoverageStateTag, readonly string[]>

const MAPPED_TAGS = Object.keys(GOOGLE_COVERAGE_STATES) as MappedCoverageStateTag[]

const TAG_BY_PROSE: ReadonlyMap<string, MappedCoverageStateTag> = new Map(
  MAPPED_TAGS.flatMap(tag => GOOGLE_COVERAGE_STATES[tag].map(prose => [prose, tag] as const)),
)

/** Parse Google's coverage prose for one URL. Surrounding whitespace is ignored. */
export function parseCoverageState(coverageState: string | null | undefined): CoverageState {
  const prose = coverageState?.trim()
  if (!prose)
    return { _tag: 'not_reported' }
  const tag = TAG_BY_PROSE.get(prose)
  return tag ? { _tag: tag } : { _tag: 'unrecognized', coverageState: prose }
}

/** Zero for every coverage state tag. */
export function emptyCoverageStateCounts(): CoverageStateCounts {
  const counts = { unrecognized: 0, not_reported: 0 } as CoverageStateCounts
  for (const tag of MAPPED_TAGS)
    counts[tag] = 0
  return counts
}

/** Count parsed coverage states over URL Inspection results. */
export function countCoverageStates(
  coverageStates: Iterable<string | null | undefined>,
): CoverageStateCounts {
  const counts = emptyCoverageStateCounts()
  for (const coverageState of coverageStates)
    counts[parseCoverageState(coverageState)._tag]++
  return counts
}

function sqlString(value: string): string {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

/**
 * A SQL `CASE` expression that yields the coverage state tag for `column`, from
 * the same prose table as {@link parseCoverageState}. It uses exact `IN` matches
 * and `TRIM`, so it runs unchanged on SQLite and DuckDB. `column` is trusted SQL:
 * pass a column name or a cast, never user input.
 */
export function coverageStateTagSql(column: string): string {
  const branches = MAPPED_TAGS.map(tag =>
    `WHEN TRIM(${column}) IN (${GOOGLE_COVERAGE_STATES[tag].map(sqlString).join(', ')}) THEN ${sqlString(tag)}`,
  )
  return `CASE WHEN ${column} IS NULL OR TRIM(${column}) = '' THEN 'not_reported' ${branches.join(' ')} ELSE 'unrecognized' END`
}

const DAY_MS = 86_400_000

/**
 * The inspection-time cutoffs for verdicts older than 7 and 30 days, as ISO
 * strings. RFC 3339 UTC strings sort in time order, so a stored `inspectedAt`
 * string compares against these directly.
 */
export function verdictAgeCutoffs(nowMs: number): { olderThan7d: string, olderThan30d: string } {
  return {
    olderThan7d: new Date(nowMs - 7 * DAY_MS).toISOString(),
    olderThan30d: new Date(nowMs - 30 * DAY_MS).toISOString(),
  }
}

function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0
}

/**
 * Turn verdict age counts into the wire freshness shape. The input is untrusted
 * arithmetic from a SQL row, so counts are clamped: an older bucket can never
 * exceed a younger one, and no bucket can exceed `verdicts`.
 */
export function measureVerdictFreshness(input: {
  verdicts: number
  olderThan7d: number
  olderThan30d: number
}): VerdictFreshness {
  const verdicts = Math.max(0, Math.trunc(input.verdicts))
  const olderThan7d = Math.min(verdicts, Math.max(0, Math.trunc(input.olderThan7d)))
  const olderThan30d = Math.min(olderThan7d, Math.max(0, Math.trunc(input.olderThan30d)))
  return {
    _tag: 'measured',
    verdicts,
    olderThan7d,
    olderThan30d,
    olderThan7dPercent: percentOf(olderThan7d, verdicts),
    olderThan30dPercent: percentOf(olderThan30d, verdicts),
  }
}
