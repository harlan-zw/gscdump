import type { IndexingMarkdownSite } from '../src/indexing'
import { describe, expect, it } from 'vitest'
import { bucketIndexingSeries, buildIndexingPortfolioMarkdown, indexingMarkdownBucketDays } from '../src/indexing'

function markdownSite(name: string, trend: IndexingMarkdownSite['trend'], extra: Partial<IndexingMarkdownSite> = {}): IndexingMarkdownSite {
  return {
    name,
    hostname: `${name}.com`,
    hasGsc: true,
    indexed: 80,
    totalUrls: 100,
    indexedPercent: 80,
    change7d: 1.5,
    change28d: -2,
    trend,
    latestIssues: { notFound: 2, soft404: 0, serverError: 1 },
    ...extra,
  }
}

describe('bucketIndexingSeries', () => {
  it('anchors full buckets on the latest day, oldest first', () => {
    const trend = Array.from({ length: 10 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, indexedPercent: index * 10, errors: 1 }))
    expect(bucketIndexingSeries(trend, 7)).toEqual([
      { start: '2026-11-01', end: '2026-11-03', indexedPercent: 10, errors: 3 },
      { start: '2026-11-04', end: '2026-11-10', indexedPercent: 60, errors: 7 },
    ])
    expect(bucketIndexingSeries([], 7)).toEqual([])
  })

  it('sizes buckets per preset Period and falls back to weekly', () => {
    expect(indexingMarkdownBucketDays('7d')).toBe(1)
    expect(indexingMarkdownBucketDays('12m')).toBe(30)
    expect(indexingMarkdownBucketDays('custom:2026-01-01:2026-02-01')).toBe(7)
    expect(indexingMarkdownBucketDays('constructor')).toBe(7)
  })
})

describe('buildIndexingPortfolioMarkdown', () => {
  const trend = [{ date: '2026-11-01', indexedPercent: 70, errors: 2 }, { date: '2026-11-02', indexedPercent: 80, errors: 3 }]

  it('leads a Portfolio copy with the merged table and says which Sites it omits', () => {
    const markdown = buildIndexingPortfolioMarkdown({
      title: 'Client sites',
      periodLabel: 'Last 7 days',
      range: { start: '2026-11-01', end: '2026-11-02' },
      sites: [
        markdownSite('a', trend),
        markdownSite('b', [{ date: '2026-11-02', indexedPercent: 60, errors: 0 }], { indexed: 20, totalUrls: 100, indexedPercent: 20, latestIssues: null, change7d: null, change28d: null }),
        markdownSite('c', null, { hasGsc: false }),
      ],
    }, '7d')
    expect(markdown).toBe(`# Indexing coverage: Client sites
Period: Last 7 days (2026-11-01 → 2026-11-02).
Scope: registered host only, subdomains excluded. Source: Google Search Console URL Inspection / coverage.
Buckets are rolling and equal-length, oldest first. Indexed % is the mean across the bucket's days; errors are summed.
Coverage: 2 of 3 sites have indexing data; the rest are omitted.

## Portfolio (2 sites)
Indexed: 100 / 200 (50.0%)

| Period | Indexed % | Errors |
| --- | ---: | ---: |
| 2026-11-01 → 2026-11-01 | 70.0% | 2 |
| 2026-11-02 → 2026-11-02 | 70.0% | 3 |

## a (a.com)
Indexed: 80 / 100 (80.0%)
Δ 7d +1.5%   Δ 28d -2.0%
Errors: 3 (not-found 2, server-error 1)

| Period | Indexed % | Errors |
| --- | ---: | ---: |
| 2026-11-01 → 2026-11-01 | 70.0% | 2 |
| 2026-11-02 → 2026-11-02 | 80.0% | 3 |

## b (b.com)
Indexed: 20 / 100 (20.0%)
Errors: n/a

| Period | Indexed % | Errors |
| --- | ---: | ---: |
| 2026-11-02 → 2026-11-02 | 60.0% | 0 |
`)
  })

  it('skips the Portfolio table for one Site and says when no Site has data', () => {
    const one = buildIndexingPortfolioMarkdown({ title: 'a', periodLabel: 'Last 28 days', range: null, sites: [markdownSite('a', trend, { hostname: 'a' })] }, '28d')
    expect(one).not.toContain('## Portfolio')
    expect(one).toContain('## a\n')
    expect(buildIndexingPortfolioMarkdown({ title: 'none', periodLabel: 'Last 28 days', range: null, sites: [markdownSite('a', [])] }, '28d'))
      .toContain('_No indexing data available for the selected period._')
  })
})
