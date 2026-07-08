import { describe, expect, it } from 'vitest'
import {
  INDEXING_ISSUE_FILTERS,
  INDEXING_ISSUE_LABELS,
  INDEXING_ISSUE_SEVERITY,
  KNOWN_COVERAGE_STATES,
  KNOWN_PAGE_FETCH_STATES,
  unmappedInspectionReasons,
} from '../../src/core/indexing-issues'

const FILTER_KEYS = Object.keys(INDEXING_ISSUE_FILTERS)

describe('iNDEXING_ISSUE_FILTERS', () => {
  it('labels and severities cover exactly the filter keys', () => {
    expect(Object.keys(INDEXING_ISSUE_LABELS).sort()).toEqual([...FILTER_KEYS].sort())
    expect(Object.keys(INDEXING_ISSUE_SEVERITY).sort()).toEqual([...FILTER_KEYS].sort())
  })

  // The regression this whole module exists for: Google mailed
  // "Blocked due to access forbidden (403)" and the product had no bucket to put it in.
  it.each([
    ['ACCESS_FORBIDDEN', 'access_forbidden'],
    ['ACCESS_DENIED', 'access_denied'],
    ['BLOCKED_4XX', 'blocked_4xx'],
    ['REDIRECT_ERROR', 'redirect_error'],
    ['SERVER_ERROR', 'server_error'],
    ['SOFT_404', 'soft_404'],
    ['NOT_FOUND', 'not_found'],
    ['INTERNAL_CRAWL_ERROR', 'crawl_error'],
    ['INVALID_URL', 'crawl_error'],
  ])('page_fetch_state %s is bucketed as %s', (state, key) => {
    expect(INDEXING_ISSUE_FILTERS[key as keyof typeof INDEXING_ISSUE_FILTERS]).toContain(state)
  })

  it('every fault page_fetch_state Google can return has a filter that names it', () => {
    const nonFault = new Set(['PAGE_FETCH_STATE_UNSPECIFIED', 'SUCCESSFUL', 'BLOCKED_ROBOTS_TXT'])
    const allFilters = Object.values(INDEXING_ISSUE_FILTERS).join(' ')
    for (const state of KNOWN_PAGE_FETCH_STATES) {
      if (nonFault.has(state))
        continue
      expect(allFilters, state).toContain(`'${state}'`)
    }
  })

  it('access-fault buckets are errors; expected-behaviour buckets are not', () => {
    for (const key of ['access_forbidden', 'access_denied', 'blocked_4xx', 'redirect_error'] as const)
      expect(INDEXING_ISSUE_SEVERITY[key], key).toBe('error')
    for (const key of ['redirect', 'alternate_canonical'] as const)
      expect(INDEXING_ISSUE_SEVERITY[key], key).toBe('info')
    // A redirect the site itself submitted in a sitemap IS actionable.
    expect(INDEXING_ISSUE_SEVERITY.sitemap_redirect).toBe('warning')
  })

  it('sitemap_redirect narrows redirect to sitemap-submitted URLs', () => {
    expect(INDEXING_ISSUE_FILTERS.sitemap_redirect).toContain(`coverage_state = 'Page with redirect'`)
    expect(INDEXING_ISSUE_FILTERS.sitemap_redirect).toContain('sitemaps')
  })
})

describe('unmappedInspectionReasons', () => {
  it('returns nothing when every reason is known', () => {
    const result = unmappedInspectionReasons([
      { coverageState: 'Submitted and indexed', pageFetchState: 'SUCCESSFUL' },
      { coverageState: 'Blocked due to access forbidden (403)', pageFetchState: 'ACCESS_FORBIDDEN' },
      { coverageState: null, pageFetchState: undefined },
    ])
    expect(result).toEqual({ coverageStates: [], pageFetchStates: [] })
  })

  it('surfaces a coverage state Google invented that we have no bucket for', () => {
    const result = unmappedInspectionReasons([
      { coverageState: 'Blocked due to teapot (418)', pageFetchState: 'IM_A_TEAPOT' },
      { coverageState: 'Blocked due to teapot (418)', pageFetchState: 'IM_A_TEAPOT' },
    ])
    expect(result.coverageStates).toEqual(['Blocked due to teapot (418)'])
    expect(result.pageFetchStates).toEqual(['IM_A_TEAPOT'])
  })

  it('ignores whitespace-only reasons', () => {
    expect(unmappedInspectionReasons([{ coverageState: '   ', pageFetchState: '' }]))
      .toEqual({ coverageStates: [], pageFetchStates: [] })
  })

  it('every known coverage state that is a fault reaches a filter', () => {
    // Guards the inverse of the canary: a state can be "known" (no warning logged)
    // only because someone listed it — this asserts it is also bucketed, or is one
    // of the explicitly non-fault / structurally-matched states.
    const nonFault = new Set([
      'Submitted and indexed',
      'Indexed, not submitted in sitemap',
      'Indexed, though blocked by robots.txt',
      'Indexed; consider marking as canonical',
    ])
    // Matched by predicate shape rather than by literal string.
    const structural = new Set([
      'Excluded by ‘noindex’ tag', // noindex: coverage_state LIKE '%noindex%'
      'Duplicate without user-selected canonical', // canonical_mismatch / not_indexed
      'Duplicate, Google chose different canonical than user', // canonical_mismatch
      'Blocked by page removal tool', // no fetch state; falls to not_indexed
      'Blocked by robots.txt', // blocked_robots: robots_txt_state = 'DISALLOWED'
    ])
    const allFilters = Object.values(INDEXING_ISSUE_FILTERS).join(' ')
    for (const state of KNOWN_COVERAGE_STATES) {
      if (nonFault.has(state) || structural.has(state))
        continue
      expect(allFilters, state).toContain(`'${state}'`)
    }
  })
})
