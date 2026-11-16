import type { IndexingDiagnosisActionId, IndexingDiagnosisReason, IndexingOverviewInput, TrustGateInput } from '../src/indexing'
import { describe, expect, it, vi } from 'vitest'
import {
  buildIndexingOverviewModel,
  classifyCurrentSitemapDrop,
  compareCurrentSitemapScope,
  computeTrustGate,
  countInspectionStages,
  indexingActionForIssue,
  isTrustDegraded,
  sitemapHistoryCollapsed,
} from '../src/indexing'

const now = new Date('2026-10-02T14:00:00Z')

const gateInput: TrustGateInput = {
  connected: true,
  inspectedCount: 100,
  totalUrls: 100,
  indexingStatus: 'complete',
  sitemapsPending: false,
  noSitemapsSubmitted: false,
  liveness: null,
  lastDownloadedAt: now.toISOString(),
  sitemapCollapsed: false,
  now,
}

const staleDownload = '2026-09-25T13:43:01.441Z'
const failedProbe = { status: 'error', statusCode: 503 } as const

describe('computeTrustGate', () => {
  it('checks setup before liveness', () => {
    expect(computeTrustGate({ ...gateInput, connected: false, liveness: failedProbe }).state).toBe('not_connected')
    expect(computeTrustGate({ ...gateInput, noSitemapsSubmitted: true, liveness: { status: 'reachable' } }))
      .toEqual({ state: 'no_sitemap', reason: 'Sitemap is reachable but not submitted in Search Console.' })
    expect(computeTrustGate({ ...gateInput, liveness: { status: 'error', statusCode: 404 } }).state).toBe('no_sitemap')
  })

  // Ported from request-indexing `shared/trust-gate.test.ts`.
  it('attributes the wait to Google only when its sitemap report is pending', () => {
    expect(computeTrustGate({ ...gateInput, inspectedCount: 0, totalUrls: 0, sitemapsPending: true }))
      .toMatchObject({ state: 'pending', reason: 'Sitemap is submitted and waiting for Google to parse it.' })
  })

  // request-indexing returns `broken` here, before inspection starts. nuxtseo.com
  // waits for an inspection first, and that rule is kept.
  it('keeps a corroborated probe failure pending until the first inspection', () => {
    expect(computeTrustGate({ ...gateInput, inspectedCount: 0, totalUrls: 0, indexingStatus: 'pending', lastDownloadedAt: staleDownload, liveness: failedProbe }).state).toBe('pending')
  })

  it('reads a partial sync as data and other statuses as still syncing', () => {
    expect(computeTrustGate({ ...gateInput, indexingStatus: 'partial' }).state).toBe('ok')
    expect(computeTrustGate({ ...gateInput, indexingStatus: 'pending' }).state).toBe('pending')
  })

  it('needs corroboration before a probe failure turns red', () => {
    expect(computeTrustGate({ ...gateInput, liveness: failedProbe }).state).toBe('blip')
    expect(computeTrustGate({ ...gateInput, liveness: failedProbe, lastDownloadedAt: staleDownload }).state).toBe('broken')
    expect(computeTrustGate({ ...gateInput, liveness: { status: 'timeout' }, sitemapCollapsed: true }))
      .toEqual({ state: 'broken', reason: 'Sitemap is timing out, so indexing cannot be confirmed.' })
  })

  // gscdump.com runs no probe and demotes a stale download to `blip`. nuxtseo.com
  // reads it as `unknown`, and that rule is kept.
  it('cannot confirm an unprobed Site with corroborated stored evidence', () => {
    expect(computeTrustGate({ ...gateInput, lastDownloadedAt: staleDownload }).state).toBe('unknown')
    expect(computeTrustGate(gateInput).state).toBe('ok')
    expect(isTrustDegraded('unknown')).toBe(true)
    expect(isTrustDegraded('ok')).toBe(false)
  })
})

// nuxtseo.com handed date-ascending counts to helpers that read newest first, so
// a growing Site read as a collapse. gscdump.com fixed the order. The helpers
// now take dated points and order them themselves.
describe('sitemap count history', () => {
  const growth = [
    { date: '2026-09-01', urlCount: 4 },
    { date: '2026-09-02', urlCount: 500 },
    { date: '2026-09-03', urlCount: 1000 },
  ]
  const collapse = [
    { date: '2026-09-03', urlCount: 30 },
    { date: '2026-09-01', urlCount: 1000 },
    { date: '2026-09-02', urlCount: 990 },
  ]

  it('never reads growth as a collapse, in any input order', () => {
    expect(sitemapHistoryCollapsed(growth)).toBe(false)
    expect(sitemapHistoryCollapsed(growth.toReversed())).toBe(false)
    expect(compareCurrentSitemapScope(growth)).toEqual({ current: 1000, highWater: 500, collapsed: false })
  })

  it('finds a drop below 20% of the earlier peak', () => {
    expect(sitemapHistoryCollapsed(collapse)).toBe(true)
    expect(compareCurrentSitemapScope(collapse)).toEqual({ current: 30, highWater: 1000, collapsed: true })
    expect(classifyCurrentSitemapDrop([...collapse, { date: '2026-08-31', urlCount: 1000 }])).toMatchObject({ _tag: 'awaiting_confirmation', current: 30 })
  })
})

describe('countInspectionStages', () => {
  const rows = [
    { verdict: 'PASS' },
    { verdict: 'NEUTRAL', pageFetchState: 'SUCCESSFUL', indexingState: 'INDEXING_ALLOWED', robotsTxtState: 'ALLOWED' },
    { verdict: 'NEUTRAL', pageFetchState: 'SUCCESSFUL', indexingState: 'INDEXING_ALLOWED', robotsTxtState: 'DISALLOWED' },
    { verdict: 'NEUTRAL', lastCrawlTime: '2026-09-01T00:00:00Z' },
    { verdict: 'NEUTRAL' },
  ]

  it('counts each stage from complete rows', () => {
    expect(countInspectionStages({ urls: rows, pagination: { total: 5, hasMore: false }, inspectedCount: 5 }))
      .toEqual({ _tag: 'available', inspected: 5, crawled: 4, indexable: 2, indexed: 1 })
  })

  // Ported from gscdump.com `tests/indexing-snapshot-counts.test.ts`.
  it('refuses a partial page and a population mismatch', () => {
    expect(countInspectionStages({ urls: rows, pagination: { total: 1000, hasMore: true }, inspectedCount: 200 }))
      .toEqual({ _tag: 'unavailable', reason: 'partial_rows' })
    expect(countInspectionStages({ urls: rows, pagination: { total: 5, hasMore: false }, inspectedCount: 200 }))
      .toEqual({ _tag: 'unavailable', reason: 'scope_mismatch' })
  })
})

interface TestDiagnosis {
  reason: IndexingDiagnosisReason
  recommendedActions: Array<{ id: IndexingDiagnosisActionId, title: string }>
}

function diagnosis(reason: IndexingDiagnosisReason, ...ids: IndexingDiagnosisActionId[]): TestDiagnosis {
  return { reason, recommendedActions: ids.map(id => ({ id, title: id })) }
}

const overviewInput: IndexingOverviewInput = {
  totalUrls: 200,
  indexed: 187,
  issues: [
    { type: 'discovered_not_indexed', label: 'Discovered, not indexed', count: 5, severity: 'warning' },
    { type: 'crawled_not_indexed', label: 'Crawled, not indexed', count: 5, severity: 'warning' },
    { type: 'unknown_to_google', label: 'Unknown to Google', count: 3 },
    { type: 'not_indexed', label: 'Not indexed', count: 13 },
  ],
  indexingStatus: 'complete',
  inspectedCount: 200,
  sitemapTotal: 200,
  sitemapHistory: [{ date: '2026-09-01', urlCount: 4 }, { date: '2026-09-02', urlCount: 200 }],
  stages: { _tag: 'available', inspected: 200, crawled: 195, indexable: 190, indexed: 187 },
  trust: { state: 'ok', reason: 'Google is indexing the pages it discovers.' },
}

describe('buildIndexingOverviewModel', () => {
  it('waits without diagnosing while setup is pending', () => {
    const diagnose = vi.fn()
    const model = buildIndexingOverviewModel({ ...overviewInput, trust: { state: 'not_connected', reason: 'Search Console is not connected.' } }, diagnose)
    expect(model).toEqual({ _tag: 'waiting', state: 'not_connected', reason: 'Search Console is not connected.', progress: { inspected: 200, total: 200 } })
    expect(diagnose).not.toHaveBeenCalled()
  })

  it('shows a trust failure, then a collapsed sitemap scope, before any diagnosis', () => {
    const diagnose = vi.fn()
    expect(buildIndexingOverviewModel({ ...overviewInput, trust: { state: 'broken', reason: 'x' } }, diagnose)._tag).toBe('trust_failure')
    const collapsed = buildIndexingOverviewModel({ ...overviewInput, sitemapHistory: [{ date: '2026-09-02', urlCount: 30 }, { date: '2026-09-01', urlCount: 1000 }] }, diagnose)
    expect(collapsed).toMatchObject({ _tag: 'verify_scope', current: 30, highWater: 1000 })
    expect(diagnose).not.toHaveBeenCalled()
  })

  it('holds a clean diagnosis as partial scope until every sitemap URL is inspected', () => {
    const model = buildIndexingOverviewModel({ ...overviewInput, sitemapTotal: 1377, indexingStatus: 'partial' }, () => diagnosis('none'))
    expect(model).toMatchObject({ _tag: 'partial_scope', reason: '200 of 1,377 sitemap URLs are inspected. Keep collecting evidence before calling coverage complete.' })
  })

  // Ported from gscdump.com `tests/indexing-snapshot-counts.test.ts`: the
  // diagnostic numerator and denominator stay paired.
  it('pairs every count with the inspected denominator and leads with the aligned action', () => {
    const model = buildIndexingOverviewModel(overviewInput, () => diagnosis('discovered_not_crawled', 'run-url-level-triage', 'strengthen-crawl-priority'))
    if (model._tag !== 'diagnosis')
      throw new Error(`expected a diagnosis, got ${model._tag}`)
    expect(model.scope).toMatchObject({ inspected: 200, indexedLabel: '187 of 200 inspected', complete: true })
    expect(model.counts.slice(0, 2)).toEqual([
      { id: 'indexed', value: 187, label: '187 of 200 inspected' },
      { id: 'not-indexed', value: 13, label: '13 of 200 inspected' },
    ])
    expect(model.primaryAction).toMatchObject({ engineActionId: 'strengthen-crawl-priority', issueType: 'discovered_not_indexed', buttonLabel: 'Review uncrawled URLs' })
    expect(model.reasonGroups.map(group => group.id)).toEqual(['discovery', 'selection', 'unknown'])
    expect(model.stages).toMatchObject({ _tag: 'available', largestLoss: { from: 'Inspected', to: 'Crawled', count: 5 } })
  })

  it('drops the stages when their population differs from the counted summary', () => {
    const model = buildIndexingOverviewModel({ ...overviewInput, stages: { _tag: 'available', inspected: 1000, crawled: 900, indexable: 800, indexed: 564 } }, () => diagnosis('discovered_not_crawled'))
    expect(model).toMatchObject({ _tag: 'diagnosis', stages: { _tag: 'unavailable', reason: 'scope_mismatch' }, primaryAction: null })
  })

  it('carries a blip as a note on the diagnosis', () => {
    const model = buildIndexingOverviewModel({ ...overviewInput, trust: { state: 'blip', reason: 'Could not reach the sitemap just now, retrying.' } }, () => diagnosis('crawl_blocked'))
    expect(model).toMatchObject({ _tag: 'diagnosis', trustNote: 'Could not reach the sitemap just now, retrying.' })
  })
})

describe('indexingActionForIssue', () => {
  it('finds the action that addresses an issue type', () => {
    const found = diagnosis('mixed_indexing_failure', 'fix-crawl-access', 'align-indexability-signals')
    expect(indexingActionForIssue(found, 'soft_404')?.id).toBe('fix-crawl-access')
    expect(indexingActionForIssue(found, 'alternate_canonical')?.id).toBe('align-indexability-signals')
    expect(indexingActionForIssue(found, 'unknown_to_google')).toBeUndefined()
  })
})
