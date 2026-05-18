import { describe, expect, it, vi } from 'vitest'
import { canUseUrlInspection, inspectUrlFlat } from '../../src/api/inspection'
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
