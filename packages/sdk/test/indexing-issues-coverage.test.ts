// Drift guard: every issue key the core filter map can emit must have a
// description + fix (`issueDetails`) and a home in the UI (`issueGroups`).
//
// Without this, adding a filter key upstream ships a bucket that counts URLs but
// renders as a bare slug with no explanation and no group — the same
// "detected but never surfaced" failure the 403 bucket was added to fix.
// Mirror of `gscdump.com/test/inspection-issue-filters-parity.test.ts`, which
// guards the DuckDB half of the same contract.
import { INDEXING_ISSUE_FILTERS, INDEXING_ISSUE_LABELS, INDEXING_ISSUE_SEVERITY } from 'gscdump'
import { describe, expect, it } from 'vitest'
import { issueDetails, issueGroups } from '../src/indexing-issues'

const FILTER_KEYS = Object.keys(INDEXING_ISSUE_FILTERS)

// Verdict/quality keys, not coverage reasons: they describe a rich-results or
// mobile outcome on an already-indexed page, so they never render in the
// indexing-issue catalog. Explicitly listed rather than silently skipped.
const NON_COVERAGE_KEYS = new Set([
  'mobile_fail',
  'rich_results_fail',
  'rich_results_warning',
  'rich_results_pass',
])

// `not_indexed` is the verdict-derived aggregate (`verdict IN (FAIL, PARTIAL,
// NEUTRAL)`) that every specific reason below is a subset of. It carries a
// description because a bare count still needs explaining, but it deliberately
// has NO group: placing it beside its own members would double-count every URL.
const UMBRELLA_KEYS = new Set(['not_indexed'])

const COVERAGE_KEYS = FILTER_KEYS.filter(k => !NON_COVERAGE_KEYS.has(k))
const GROUPED_KEYS = COVERAGE_KEYS.filter(k => !UMBRELLA_KEYS.has(k))

describe('sDK indexing-issue catalog covers the core filter map', () => {
  it.each(COVERAGE_KEYS)('%s has a description and a fix', (key) => {
    expect(issueDetails[key], `issueDetails.${key} missing`).toBeDefined()
    expect(issueDetails[key]!.description.length, `${key} description`).toBeGreaterThan(20)
    expect(issueDetails[key]!.fix.length, `${key} fix`).toBeGreaterThan(20)
  })

  it.each(GROUPED_KEYS)('%s belongs to exactly one issue group', (key) => {
    const owners = issueGroups.filter(g => g.issueTypes.includes(key))
    expect(owners.length, `${key} owned by ${owners.length} groups`).toBe(1)
  })

  it('the umbrella aggregate is never placed in a group', () => {
    for (const key of UMBRELLA_KEYS) {
      expect(issueDetails[key], `${key} should still be explained`).toBeDefined()
      const owners = issueGroups.filter(g => g.issueTypes.includes(key))
      expect(owners.length, `${key} must not be grouped (double-counts)`).toBe(0)
    }
  })

  it('no group references an issue type the core filters cannot emit', () => {
    const known = new Set([...FILTER_KEYS, 'stale_crawl'])
    for (const group of issueGroups) {
      for (const type of group.issueTypes)
        expect(known.has(type), `${group.id} references unknown issue type ${type}`).toBe(true)
    }
  })

  it('every issueDetails entry corresponds to a real filter key', () => {
    // `stale_crawl` is a core key; the reverse direction catches typos and
    // orphaned entries left behind when a filter is renamed or removed.
    for (const key of Object.keys(issueDetails))
      expect(FILTER_KEYS, `issueDetails.${key} has no filter`).toContain(key)
  })

  it('labels and severities exist for every key the SDK documents', () => {
    for (const key of Object.keys(issueDetails)) {
      expect(INDEXING_ISSUE_LABELS[key as keyof typeof INDEXING_ISSUE_LABELS], key).toBeTruthy()
      expect(INDEXING_ISSUE_SEVERITY[key as keyof typeof INDEXING_ISSUE_SEVERITY], key).toBeTruthy()
    }
  })
})
