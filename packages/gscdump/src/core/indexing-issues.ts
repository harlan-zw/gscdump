// Predefined issue filters for indexing status.
// Each maps to a SQL condition against a `url_indexing_status`-shaped table.
// Consumers compose these into queries against their own storage.
//
// COVERAGE CONTRACT: every value Google can put in `page_fetch_state`, and every
// not-indexed `coverage_state` string it can report, must be reachable by at least
// one filter below. `unmappedInspectionReasons()` is the runtime guard on that
// contract — call it at the ingest boundary so a new Google reason surfaces as a
// log line rather than silently collapsing into the generic `not_indexed` bucket.

/**
 * JS twin of the `fragment_url` SQL predicate below.
 *
 * Google does not index fragments as distinct entities — a `#anchor` URL always
 * resolves to its parent document — so inspecting one can never return a useful
 * verdict, and counting one inflates every per-URL total by a phantom row. Write
 * paths reject these; read paths exclude them.
 *
 * Kept beside {@link INDEXING_ISSUE_FILTERS} so the JS and SQL sides of the rule
 * cannot drift; call sites must use this rather than re-deriving `includes('#')`.
 */
export function isFragmentUrl(url: string): boolean {
  return typeof url === 'string' && url.includes('#')
}

export const INDEXING_ISSUE_FILTERS = {
  canonical_mismatch: `user_canonical IS NOT NULL AND google_canonical IS NOT NULL AND user_canonical != google_canonical`,
  stale_crawl: `last_crawl_time < datetime('now', '-30 days')`,
  very_stale_crawl: `last_crawl_time < datetime('now', '-60 days')`,
  not_indexed: `verdict IN ('FAIL', 'PARTIAL', 'NEUTRAL')`,
  unknown_to_google: `coverage_state = 'URL is unknown to Google'`,
  crawled_not_indexed: `coverage_state = 'Crawled - currently not indexed'`,
  discovered_not_indexed: `coverage_state = 'Discovered - currently not indexed'`,
  not_found: `page_fetch_state = 'NOT_FOUND' OR coverage_state = 'Not found (404)'`,
  // The `coverage_state` half is load-bearing, not belt-and-braces: a soft 404 is BY
  // DEFINITION a page that returns HTTP 200 with error-looking content, so Google
  // reports `pageFetchState: SUCCESSFUL` on it. `page_fetch_state = 'SOFT_404'` is a
  // state the API effectively never emits — measured on prod, 45/45 soft 404s carried
  // `SUCCESSFUL`, and 0 rows fleet-wide had the SOFT_404 fetch state. Dropping the
  // coverage_state clause silently zeroes an error-severity bucket.
  soft_404: `page_fetch_state = 'SOFT_404' OR coverage_state = 'Soft 404'`,
  server_error: `page_fetch_state = 'SERVER_ERROR' OR coverage_state = 'Server error (5xx)'`,
  access_forbidden: `page_fetch_state = 'ACCESS_FORBIDDEN' OR coverage_state = 'Blocked due to access forbidden (403)'`,
  access_denied: `page_fetch_state = 'ACCESS_DENIED' OR coverage_state = 'Blocked due to unauthorized request (401)'`,
  blocked_4xx: `page_fetch_state = 'BLOCKED_4XX' OR coverage_state = 'Blocked due to other 4xx issue'`,
  redirect_error: `page_fetch_state = 'REDIRECT_ERROR' OR coverage_state = 'Redirect error'`,
  crawl_error: `page_fetch_state IN ('INTERNAL_CRAWL_ERROR', 'INVALID_URL')`,
  blocked_robots: `robots_txt_state = 'DISALLOWED'`,
  noindex: `indexing_state LIKE '%noindex%' OR coverage_state LIKE '%noindex%'`,
  redirect: `coverage_state = 'Page with redirect'`,
  // A redirect Google reached from a link is expected; a redirect on a URL the site
  // SUBMITTED in its sitemap is a fault the owner declared and can fix. Google draws
  // the same line — it mails "pages in a sitemap" separately from "pages".
  sitemap_redirect: `coverage_state = 'Page with redirect' AND sitemaps IS NOT NULL AND sitemaps != '[]'`,
  alternate_canonical: `coverage_state = 'Alternate page with proper canonical tag'`,
  // NOT reachable via `canonical_mismatch`: that predicate needs BOTH canonicals
  // non-null, and this state means the page declared none at all (verified on prod:
  // 10/10 such rows have `user_canonical IS NULL`). Without its own key these URLs
  // fall into the generic `not_indexed` bucket and disappear.
  duplicate_no_canonical: `coverage_state = 'Duplicate without user-selected canonical'`,
  // Google explicitly telling the owner to declare a canonical. It was already
  // in KNOWN_COVERAGE_STATES and classified non-fault, so it had no filter key,
  // no label and no surface — a directly actionable signal that was invisible.
  indexed_consider_canonical: `coverage_state = 'Indexed; consider marking as canonical'`,
  page_removed: `coverage_state = 'Blocked by page removal tool'`,
  fragment_url: `url LIKE '%#%'`,
  mobile_fail: `mobile_verdict IN ('FAIL', 'PARTIAL')`,
  rich_results_fail: `rich_results_verdict = 'FAIL'`,
  rich_results_warning: `rich_results_verdict = 'PARTIAL'`,
  rich_results_pass: `rich_results_verdict = 'PASS'`,
} as const

export type IndexingIssueType = keyof typeof INDEXING_ISSUE_FILTERS

export const INDEXING_ISSUE_LABELS: Record<IndexingIssueType, string> = {
  canonical_mismatch: 'Canonical mismatch',
  stale_crawl: 'Not crawled in 30+ days',
  very_stale_crawl: 'Not crawled in 60+ days',
  not_indexed: 'Not indexed',
  unknown_to_google: 'Unknown to Google',
  crawled_not_indexed: 'Crawled but not indexed',
  discovered_not_indexed: 'Discovered but not indexed',
  not_found: '404 Not Found',
  soft_404: 'Soft 404',
  server_error: 'Server error',
  access_forbidden: 'Blocked: forbidden (403)',
  access_denied: 'Blocked: unauthorized (401)',
  blocked_4xx: 'Blocked: other 4xx',
  redirect_error: 'Redirect error',
  crawl_error: 'Crawl error',
  blocked_robots: 'Blocked by robots.txt',
  noindex: 'Noindex tag',
  redirect: 'Redirect',
  sitemap_redirect: 'Sitemap URL redirects',
  alternate_canonical: 'Alternate page with canonical',
  duplicate_no_canonical: 'Duplicate, no canonical declared',
  indexed_consider_canonical: 'Indexed, Google suggests a canonical',
  page_removed: 'Removed via removal tool',
  fragment_url: 'Fragment URL (#)',
  mobile_fail: 'Mobile usability issues',
  rich_results_fail: 'Rich results errors',
  rich_results_warning: 'Rich results warnings',
  rich_results_pass: 'Has rich results',
}

export const INDEXING_ISSUE_SEVERITY: Record<IndexingIssueType, 'error' | 'warning' | 'info'> = {
  canonical_mismatch: 'warning',
  stale_crawl: 'info',
  very_stale_crawl: 'warning',
  not_indexed: 'error',
  unknown_to_google: 'warning',
  crawled_not_indexed: 'error',
  discovered_not_indexed: 'warning',
  not_found: 'error',
  soft_404: 'error',
  server_error: 'error',
  access_forbidden: 'error',
  access_denied: 'error',
  blocked_4xx: 'error',
  redirect_error: 'error',
  crawl_error: 'warning',
  blocked_robots: 'warning',
  noindex: 'info',
  redirect: 'info',
  sitemap_redirect: 'warning',
  alternate_canonical: 'info',
  // Google folded this page into another URL because the page named no preference.
  // Fixable in one line (declare a self-canonical, or consolidate on purpose), so
  // it earns a warning — unlike `alternate_canonical`, where the fold was intended.
  duplicate_no_canonical: 'warning',
  // The page IS indexed, so nothing is broken — but Google is naming a
  // one-line improvement it would honour. Actionable, not a fault.
  indexed_consider_canonical: 'info',
  page_removed: 'info',
  fragment_url: 'warning',
  mobile_fail: 'warning',
  rich_results_fail: 'error',
  rich_results_warning: 'warning',
  rich_results_pass: 'info',
}

// ---------------------------------------------------------------------------
// Coverage canary
// ---------------------------------------------------------------------------

/**
 * Every `pageFetchState` the URL Inspection API documents. `SUCCESSFUL` and the
 * `_UNSPECIFIED` sentinel are non-faults; the rest each map to a filter above.
 */
export const KNOWN_PAGE_FETCH_STATES: ReadonlySet<string> = new Set([
  'PAGE_FETCH_STATE_UNSPECIFIED',
  'SUCCESSFUL',
  'SOFT_404',
  'BLOCKED_ROBOTS_TXT',
  'NOT_FOUND',
  'ACCESS_DENIED',
  'SERVER_ERROR',
  'REDIRECT_ERROR',
  'ACCESS_FORBIDDEN',
  'BLOCKED_4XX',
  'INTERNAL_CRAWL_ERROR',
  'INVALID_URL',
])

/**
 * Every `coverageState` string we have a bucket for, plus the indexed-state strings
 * that are not faults. Google is free to invent new prose here at any time — that's
 * exactly what {@link unmappedInspectionReasons} exists to catch.
 */
export const KNOWN_COVERAGE_STATES: ReadonlySet<string> = new Set([
  // indexed / non-fault
  'Submitted and indexed',
  'Indexed, not submitted in sitemap',
  'Indexed, though blocked by robots.txt',
  'Indexed; consider marking as canonical',
  // bucketed faults
  'URL is unknown to Google',
  'Crawled - currently not indexed',
  'Discovered - currently not indexed',
  'Not found (404)',
  'Soft 404',
  'Server error (5xx)',
  'Blocked due to access forbidden (403)',
  'Blocked due to unauthorized request (401)',
  'Blocked due to other 4xx issue',
  'Redirect error',
  'Blocked by robots.txt',
  'Excluded by ‘noindex’ tag',
  'Page with redirect',
  'Alternate page with proper canonical tag',
  'Duplicate without user-selected canonical',
  'Duplicate, Google chose different canonical than user',
  'Blocked by page removal tool',
])

export interface UnmappedInspectionReasons {
  coverageStates: string[]
  pageFetchStates: string[]
}

/**
 * Which reason strings in this batch of inspection results we have no bucket for.
 *
 * Pure, allocation-cheap, and safe to call on every ingest batch. A non-empty
 * result means Google reports a state the filter map cannot see — the URLs are
 * still counted in `not_indexed`, but nothing narrower, so the product will
 * under-report exactly the way it did for `ACCESS_FORBIDDEN` before this existed.
 */
export function unmappedInspectionReasons(
  rows: ReadonlyArray<{ coverageState?: string | null, pageFetchState?: string | null }>,
): UnmappedInspectionReasons {
  const coverageStates = new Set<string>()
  const pageFetchStates = new Set<string>()
  for (const row of rows) {
    const coverage = row.coverageState?.trim()
    if (coverage && !KNOWN_COVERAGE_STATES.has(coverage))
      coverageStates.add(coverage)
    const fetchState = row.pageFetchState?.trim()
    if (fetchState && !KNOWN_PAGE_FETCH_STATES.has(fetchState))
      pageFetchStates.add(fetchState)
  }
  return { coverageStates: [...coverageStates], pageFetchStates: [...pageFetchStates] }
}
