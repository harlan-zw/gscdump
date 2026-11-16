import { describe, expect, it } from 'vitest'
import {
  buildIndexCohortDiagnosis,
  buildIndexCohortsFromIndexingUrls,
  indexCohortFilterValue,
  parseIndexCohortFilter,
  selectIndexCohortLead,
  selectIndexCohortUrls,
  selectIndexingRegressionLead,
} from '../src/indexing'

function row(url: string, indexed: boolean) {
  return { url, verdict: indexed ? 'PASS' : 'NEUTRAL', sitemaps: null }
}

/** `count` URLs under one prefix, the first `notIndexed` of them refused. */
function section(prefix: string, count: number, notIndexed: number) {
  return Array.from({ length: count }, (_, index) => row(`https://example.com${prefix}/page-${index}`, index >= notIndexed))
}

// Ported from request-indexing `server/utils/index-cohorts.test.ts`.
describe('buildIndexCohortsFromIndexingUrls', () => {
  it('reports no evidence when the inspection set is empty', () => {
    expect(buildIndexCohortsFromIndexingUrls({ urls: [], reportedNotIndexed: 0 })).toEqual({
      _tag: 'no-evidence',
      crawlSettingsId: null,
      asOf: null,
      reason: 'no-inspection-join',
      sample: null,
    })
  })

  it('names the section Google refuses far more often than the rest', () => {
    const result = buildIndexCohortsFromIndexingUrls({
      urls: [...section('/docs', 40, 36), ...section('/blog', 60, 2)],
      reportedNotIndexed: 38,
    })
    if (result._tag !== 'outliers')
      throw new Error(`expected outliers, got ${result._tag}`)
    expect(result.cells[0]).toMatchObject({ dimension: 'section', key: '/docs', pathPrefix: '/docs', total: 40, notIndexed: 36 })
    expect(result.baseline).toEqual({ total: 100, notIndexed: 38, rate: 0.38 })
  })

  it('reports uniform when every section fails at the same rate', () => {
    const result = buildIndexCohortsFromIndexingUrls({
      urls: [...section('/docs', 40, 8), ...section('/blog', 40, 8)],
      reportedNotIndexed: 16,
    })
    if (result._tag !== 'uniform')
      throw new Error(`expected uniform, got ${result._tag}`)
    expect(result.baseline.notIndexed).toBe(16)
    expect(result.tested).toBeGreaterThan(0)
  })

  it('counts fragment URLs as excluded rather than as not-indexed pages', () => {
    const result = buildIndexCohortsFromIndexingUrls({
      urls: [...section('/docs', 20, 4), row('https://example.com/docs/page-0#install', false), row('https://example.com/docs/page-0#usage', false)],
      reportedNotIndexed: 4,
    })
    expect(result).toMatchObject({ coverage: { analysed: 20, excludedFragments: 2, notCrawled: 0 } })
  })

  it('drops rows that are not absolute http URLs and have no Site to resolve against', () => {
    const result = buildIndexCohortsFromIndexingUrls({ urls: [...section('/docs', 20, 4), row('not a url', false), row('ftp://example.com/a', false)], reportedNotIndexed: 4 })
    expect(result).toMatchObject({ baseline: { total: 20 } })
  })

  it.each(['example.com', 'not a valid base', null])('parses absolute rows independently of Site metadata %s', (siteUrl) => {
    const result = buildIndexCohortsFromIndexingUrls({ urls: section('/docs', 20, 4), siteUrl, reportedNotIndexed: 4 })
    expect(result).toMatchObject({ baseline: { total: 20, notIndexed: 4, rate: 0.2 } })
  })

  it.each(['example.com', 'sc-domain:example.com', 'https://example.com/'])('resolves relative rows against %s', (siteUrl) => {
    const result = buildIndexCohortsFromIndexingUrls({
      urls: Array.from({ length: 20 }, (_, index) => row(`/docs/page-${index}`, index >= 4)),
      siteUrl,
      reportedNotIndexed: 4,
    })
    expect(result).toMatchObject({ baseline: { total: 20, notIndexed: 4, rate: 0.2 } })
  })

  // PR 286 Service Review. The complement is a sample too. 0 of 12 does not prove
  // the rest of the Site indexes everything, so 6 of 40 is no finding against it.
  it('finds no cohort against a small complement whose own rate is uncertain', () => {
    const result = buildIndexCohortsFromIndexingUrls({
      urls: [...section('/docs', 40, 6), ...section('/blog', 12, 0)],
      reportedNotIndexed: 6,
    })
    expect(result._tag).toBe('uniform')
  })

  // PR 286 Service Review. A repeated row is the same page, so it adds no evidence.
  it('counts a URL listed twice once in the cohort statistics', () => {
    const urls = [...section('/docs', 40, 36), ...section('/blog', 60, 2)]
    const result = buildIndexCohortsFromIndexingUrls({ urls: [...urls, ...section('/docs', 40, 36)], reportedNotIndexed: 38 })
    if (result._tag !== 'outliers')
      throw new Error(`expected outliers, got ${result._tag}`)
    expect(result.baseline).toEqual({ total: 100, notIndexed: 38, rate: 0.38 })
    expect(result.coverage.analysed).toBe(100)
    expect(result.cells[0]).toMatchObject({ key: '/docs', total: 40, notIndexed: 36 })
  })

  // A judgement call, kept: the first row for a URL wins. The rows carry no
  // inspection time, so a later row is not known to be newer.
  it('keeps the first verdict when a URL repeats with another verdict', () => {
    const result = buildIndexCohortsFromIndexingUrls({
      urls: [row('/docs/a', true), row('https://example.com/docs/a', false)],
      siteUrl: 'example.com',
      reportedNotIndexed: 0,
    })
    expect(result).toMatchObject({ baseline: { total: 1, notIndexed: 0 } })
  })

  it('carries the caller snapshot timestamp onto the wire', () => {
    const result = buildIndexCohortsFromIndexingUrls({ urls: section('/docs', 20, 4), reportedNotIndexed: 4 }, '2026-09-15T00:00:00.000Z')
    expect(result.asOf).toBe('2026-09-15T00:00:00.000Z')
    expect(result.crawlSettingsId).toBeNull()
  })
})

// The list can enumerate far fewer not-indexed URLs than gscdump reports. Every
// rate built on it would then treat the missing URLs as absent (nuxtseo.com #1306).
describe('buildIndexCohortsFromIndexingUrls with a sampled not-indexed list', () => {
  const urls = [...section('/docs', 40, 36), ...section('/blog', 60, 2)]

  it('refuses a rate when the list covers under 90% of the reported count', () => {
    expect(buildIndexCohortsFromIndexingUrls({ urls, reportedNotIndexed: 1484 }, '2026-09-30T00:00:00.000Z')).toEqual({
      _tag: 'no-evidence',
      crawlSettingsId: null,
      asOf: '2026-09-30T00:00:00.000Z',
      reason: 'sampled-index-state',
      sample: { enumerated: 38, reported: 1484 },
    })
  })

  it('refuses at 88% and computes at 90.5%', () => {
    expect(buildIndexCohortsFromIndexingUrls({ urls, reportedNotIndexed: 43 })._tag).toBe('no-evidence')
    expect(buildIndexCohortsFromIndexingUrls({ urls, reportedNotIndexed: 42 })._tag).toBe('outliers')
    expect(buildIndexCohortsFromIndexingUrls({ urls, reportedNotIndexed: 0 })._tag).toBe('outliers')
  })

  it('counts a URL listed twice once', () => {
    const result = buildIndexCohortsFromIndexingUrls({ urls: [...urls, ...section('/docs', 40, 36)], reportedNotIndexed: 1000 })
    expect(result).toMatchObject({ reason: 'sampled-index-state', sample: { enumerated: 38, reported: 1000 } })
  })
})

describe('selectIndexCohortUrls', () => {
  it('returns the exact not-indexed version group across unrelated prefixes', () => {
    const urls = [
      row('https://example.com/docs/a/v5/old', false),
      row('/guides/v3/old', false),
      row('/guides/v3/indexed', true),
      row('/guides/current', false),
      row('/releases/v5', false),
      row('/guides/v3/old#section', false),
    ]
    expect(selectIndexCohortUrls(urls, { dimension: 'lifecycle', key: 'versioned' }, 'example.com')).toEqual(urls.slice(0, 2))
  })

  it('returns a URL listed twice once, so the list matches the lead count', () => {
    const urls = [row('/docs/a', false), row('/docs/b', false), row('https://example.com/docs/a', false)]
    expect(selectIndexCohortUrls(urls, { dimension: 'section', key: '/docs' }, 'example.com')).toEqual(urls.slice(0, 2))
  })

  it('matches section segments rather than substring search', () => {
    const urls = [row('/docs', false), row('/docs/page', false), row('/docs-other/page', false), row('/blog/docs/page', false)]
    expect(selectIndexCohortUrls(urls, { dimension: 'section', key: '/docs' }, 'example.com')).toEqual(urls.slice(0, 2))
  })
})

describe('parseIndexCohortFilter', () => {
  it('parses the value a cell writes', () => {
    expect(parseIndexCohortFilter(indexCohortFilterValue({ dimension: 'section', key: '/docs/og-image' })))
      .toEqual({ _tag: 'ok', filter: { dimension: 'section', key: '/docs/og-image' } })
    expect(parseIndexCohortFilter('lifecycle:versioned')).toEqual({ _tag: 'ok', filter: { dimension: 'lifecycle', key: 'versioned' } })
  })

  it.each([undefined, 42, 'docs', 'section:docs', 'section:/a/b/c', 'lifecycle:old', ':/docs'])('rejects %s', (value) => {
    expect(parseIndexCohortFilter(value)).toEqual({ _tag: 'invalid', value })
  })
})

describe('selectIndexCohortLead', () => {
  it('leads with the worst cohort', () => {
    const diagnosis = buildIndexCohortDiagnosis({
      pages: [...section('/docs', 40, 36), ...section('/blog', 60, 2)].map(page => ({ path: new URL(page.url).pathname, indexed: page.verdict === 'PASS', inSitemap: true })),
      excludedFragments: 0,
      notCrawled: 0,
    })
    if (diagnosis._tag === 'no-evidence')
      throw new Error('expected a diagnosis')
    expect(selectIndexCohortLead(diagnosis)).toMatchObject({
      _tag: 'lead',
      title: '36 of 40 pages under /docs are missing from Google\'s index.',
      detail: 'That is 90% not indexed, against 3% across the rest of the site.',
      actionLabel: 'Review 36 URLs',
    })
  })

  // PR 286 Service Review. Unversioned pages failing must not blame version-pinned ones.
  it('names unversioned pages when the evergreen cohort leads', () => {
    const versioned = Array.from({ length: 40 }, (_, index) => ({ path: `/docs/v1/page-${index}`, indexed: true, inSitemap: true }))
    const evergreen = Array.from({ length: 30 }, (_, index) => ({ path: `/page-${index}`, indexed: index >= 15, inSitemap: true }))
    const diagnosis = buildIndexCohortDiagnosis({ pages: [...versioned, ...evergreen], excludedFragments: 0, notCrawled: 0 })
    if (diagnosis._tag !== 'outliers')
      throw new Error(`expected outliers, got ${diagnosis._tag}`)
    expect(selectIndexCohortLead(diagnosis)).toMatchObject({
      _tag: 'lead',
      title: '15 of 30 unversioned pages are missing from Google\'s index.',
      cell: { dimension: 'lifecycle', key: 'evergreen' },
    })
  })

  // request-indexing lacks this rule. nuxtseo.com refuses a cohort lead when most
  // of the Site is not indexed, and that rule is kept.
  it('gives no lead when most of the Site is not indexed', () => {
    const diagnosis = buildIndexCohortDiagnosis({
      pages: [...section('/docs', 40, 40), ...section('/blog', 60, 15)].map(page => ({ path: new URL(page.url).pathname, indexed: page.verdict === 'PASS', inSitemap: true })),
      excludedFragments: 0,
      notCrawled: 0,
    })
    expect(diagnosis._tag).toBe('outliers')
    expect(selectIndexCohortLead(diagnosis as Exclude<typeof diagnosis, { _tag: 'no-evidence' }>)).toEqual({ _tag: 'none', reason: 'site-wide' })
    expect(selectIndexCohortLead({ _tag: 'no-evidence' })).toEqual({ _tag: 'none', reason: 'no-evidence' })
  })
})

const transition = {
  url: 'https://example.com/docs/page',
  field: 'indexStatus',
  fromValue: 'PASS',
  toValue: 'FAIL',
  changedAfter: '2026-10-01T08:00:00.000Z',
  changedBefore: '2026-10-08T08:00:00.000Z',
}
const docs = { label: '/docs', pathPrefix: '/docs' }

// Adapted from gscdump.com `tests/indexing-transitions-contract.test.ts`.
// gscdump.com reads a Site-wide lead dated by `detectedAt`. nuxtseo.com and
// request-indexing scope it to a cohort path and bound it by `changedAfter` and
// `changedBefore`, and that rule is kept.
describe('selectIndexingRegressionLead', () => {
  it('bounds the window by the inspection samples', () => {
    expect(selectIndexingRegressionLead(docs, [transition])).toEqual({
      _tag: 'lead',
      count: 1,
      start: transition.changedAfter,
      end: transition.changedBefore,
      title: 'Google dropped 1 page in /docs between 1 Oct 2026 and 8 Oct 2026.',
      detail: 'URL Inspection samples bound the change window; they do not identify the exact drop time.',
    })
  })

  it('counts distinct URLs that left PASS, under the cohort path only', () => {
    const later = { ...transition, changedBefore: '2026-10-10T08:00:00.000Z' }
    expect(selectIndexingRegressionLead(docs, [
      later,
      transition,
      { ...transition, url: 'https://example.com/docs/second', toValue: null },
      { ...transition, url: 'https://example.com/docs/recovered', fromValue: 'FAIL', toValue: 'PASS' },
      { ...transition, url: 'https://example.com/docs-old/page' },
      { ...transition, url: 'https://example.com/docs/canonical', field: 'googleCanonical' },
      { ...transition, url: 'https://example.com/docs/backwards', changedAfter: '2026-10-09T00:00:00.000Z', changedBefore: '2026-10-02T00:00:00.000Z' },
    ])).toMatchObject({ _tag: 'lead', count: 2, start: transition.changedAfter, end: later.changedBefore })
  })

  it('says why there is no lead', () => {
    expect(selectIndexingRegressionLead({ label: 'Version-pinned paths', pathPrefix: null }, [transition])).toEqual({ _tag: 'none', reason: 'cohort-has-no-path' })
    expect(selectIndexingRegressionLead({ label: '/blog', pathPrefix: '/blog' }, [transition])).toEqual({ _tag: 'none', reason: 'no-index-regression' })
  })
})
