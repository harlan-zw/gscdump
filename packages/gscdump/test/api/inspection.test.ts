import { describe, expect, it, vi } from 'vitest'
import {
  batchInspectUrlsFlatSettled,
  canUseUrlInspection,
  describeInspectionError,
  getIndexingEligibility,
  getNextCheckAfter,
  getNextCheckPriority,
  inspectUrlFlat,
  MAX_FLAT_INSPECTION_BATCH_CONCURRENCY,
} from '../../src/api/inspection'
import { googleSearchConsole } from '../../src/core/client'

describe('inspectUrlFlat', () => {
  it('projects ampResult fields when present', async () => {
    const fetch = vi.fn().mockResolvedValue({
      inspectionResult: {
        indexStatusResult: { verdict: 'PASS' },
        ampResult: {
          verdict: 'PARTIAL',
          ampUrl: 'https://example.com/amp',
          indexingState: 'INDEXING_ALLOWED',
          ampIndexStatusVerdict: 'PASS',
          robotsTxtState: 'ALLOWED',
          pageFetchState: 'SUCCESSFUL',
          lastCrawlTime: '2026-05-17T12:00:00Z',
          issues: [{ issueMessage: 'mock', severity: 'WARNING' }],
        },
      },
    })
    const client = googleSearchConsole('t', { fetch: fetch as any })
    const result = await inspectUrlFlat(client, 'sc-domain:example.com', 'https://example.com/p')
    expect(result.ampVerdict).toBe('PARTIAL')
    expect(result.ampUrl).toBe('https://example.com/amp')
    expect(result.ampIndexingState).toBe('INDEXING_ALLOWED')
    expect(result.ampIndexStatusVerdict).toBe('PASS')
    expect(result.ampRobotsTxtState).toBe('ALLOWED')
    expect(result.ampPageFetchState).toBe('SUCCESSFUL')
    expect(result.ampLastCrawlTime).toBe('2026-05-17T12:00:00Z')
    expect(result.ampIssues).toBe('[{"issueMessage":"mock","severity":"WARNING"}]')
  })

  it('returns null AMP fields when ampResult absent', async () => {
    const fetch = vi.fn().mockResolvedValue({
      inspectionResult: { indexStatusResult: { verdict: 'PASS' } },
    })
    const client = googleSearchConsole('t', { fetch: fetch as any })
    const result = await inspectUrlFlat(client, 'sc-domain:example.com', 'https://example.com/p')
    expect(result.ampVerdict).toBeNull()
    expect(result.ampUrl).toBeNull()
    expect(result.ampIssues).toBeNull()
  })
})

describe('batchInspectUrlsFlatSettled', () => {
  it('defaults to sequential requests and preserves input order', async () => {
    let active = 0
    let maxActive = 0
    const fetch = vi.fn(async (_url: string, init: { body: { inspectionUrl: string } }) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, init.body.inspectionUrl.endsWith('/first') ? 4 : 1))
      active--
      return { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } }
    })
    const client = googleSearchConsole('t', { fetch: fetch as any })
    const urls = ['https://example.com/first', 'https://example.com/second']

    const results = await batchInspectUrlsFlatSettled(client, 'sc-domain:example.com', urls, { delayMs: 0 })

    expect(maxActive).toBe(1)
    expect(results.map(result => result.url)).toEqual(urls)
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('caps concurrency and retains each item error without rejecting the batch', async () => {
    let active = 0
    let maxActive = 0
    const failedUrl = 'https://example.com/5'
    const failure = new Error('inspection failed')
    const fetch = vi.fn(async (_url: string, init: { body: { inspectionUrl: string } }) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      if (init.body.inspectionUrl === failedUrl)
        throw failure
      return { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } }
    })
    const client = googleSearchConsole('t', { fetch: fetch as any })
    const urls = Array.from({ length: MAX_FLAT_INSPECTION_BATCH_CONCURRENCY + 2 }, (_, index) => `https://example.com/${index}`)

    const results = await batchInspectUrlsFlatSettled(client, 'sc-domain:example.com', urls, {
      concurrency: MAX_FLAT_INSPECTION_BATCH_CONCURRENCY + 100,
      delayMs: 0,
    })

    expect(maxActive).toBe(MAX_FLAT_INSPECTION_BATCH_CONCURRENCY)
    expect(results.map(result => result.url)).toEqual(urls)
    const failed = results[5]
    expect(failed).toMatchObject({ url: failedUrl, status: 'rejected' })
    expect(failed?.status === 'rejected' && failed.reason).toBe(failure)
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(urls.length - 1)
  })
})

describe('getNextCheckPriority', () => {
  it.each([
    ['PASS', 'low'],
    ['FAIL', 'high'],
    ['PARTIAL', 'high'],
    ['NEUTRAL', 'high'],
    ['VERDICT_UNSPECIFIED', 'medium'],
    [null, 'medium'],
    ['UNKNOWN_FUTURE_VERDICT', 'medium'],
  ] as const)('preserves legacy priority for verdict %s when impressions are absent', (verdict, expected) => {
    expect(getNextCheckPriority({ verdict })).toBe(expected)
    expect(getNextCheckPriority({ verdict }, undefined)).toBe(expected)
  })

  it.each([
    ['PASS', 1000, 'critical'],
    ['PASS', 10_000, 'critical'],
    ['FAIL', 10_000, 'high'],
    ['PARTIAL', 500, 'high'],
    ['NEUTRAL', 0, 'high'],
    ['PASS', 100, 'elevated'],
    ['PASS', 999, 'elevated'],
    ['PASS', 1, 'normal'],
    ['PASS', 99, 'normal'],
    ['PASS', 0, 'dormant'],
  ] as const)('returns %s with %d impressions as %s', (verdict, impressions28d, expected) => {
    expect(getNextCheckPriority({ verdict }, impressions28d)).toBe(expected)
  })
})

describe('getNextCheckAfter', () => {
  it.each([
    ['critical', 7],
    ['high', 7],
    ['medium', 14],
    ['elevated', 14],
    ['normal', 30],
    ['low', 30],
    ['dormant', 120],
  ] as const)('schedules %s after %d days', (priority, days) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'))

    expect(getNextCheckAfter(priority)).toBe(Date.parse('2026-07-26T00:00:00Z') / 1000 + days * 86400)

    vi.useRealTimers()
  })
})

describe('canUseUrlInspection', () => {
  it.each(['siteOwner', 'siteFullUser', 'siteRestrictedUser'])('allows %s', (lvl) => {
    expect(canUseUrlInspection(lvl)).toBe(true)
  })

  it('blocks siteUnverifiedUser and unknowns', () => {
    expect(canUseUrlInspection('siteUnverifiedUser')).toBe(false)
    expect(canUseUrlInspection(null)).toBe(false)
    expect(canUseUrlInspection(undefined)).toBe(false)
    expect(canUseUrlInspection('')).toBe(false)
  })
})

describe('getIndexingEligibility', () => {
  it('uses a Search Console scope for URL Inspection', () => {
    expect(getIndexingEligibility('https://www.googleapis.com/auth/webmasters.readonly', 'siteOwner')).toMatchObject({
      indexingEligible: true,
      indexingPermissionLevel: 'siteOwner',
    })

    expect(getIndexingEligibility('https://www.googleapis.com/auth/indexing', 'siteOwner')).toMatchObject({
      indexingEligible: false,
      indexingIneligibleReason: 'missing_gsc_read_scope',
      indexingPermissionLevel: 'siteOwner',
    })
  })
})

describe('describeInspectionError', () => {
  const googleError = (status: number, message: string) => Object.assign(new Error(`[POST] url: ${status}`), { statusCode: status, data: { error: { code: status, message } } })

  it.each([
    [429, 'Quota exceeded for quota metric.'],
    [403, 'Search Analytics load quota exceeded.'],
  ])('names the per-property quota for a %i quota error', (status, message) => {
    expect(describeInspectionError(googleError(status, message))).toContain('2,000 inspections per day and 600 per minute for each property')
  })

  it('names the property rule for a permission 403', () => {
    expect(describeInspectionError(googleError(403, 'You do not own this site.'))).toBe('The URL is outside this property, or you are not a full user or owner of the property.')
  })

  it('keeps Google\'s text for other failures', () => {
    expect(describeInspectionError(googleError(400, 'Invalid inspectionUrl'))).toBe('Invalid inspectionUrl')
  })
})
