import type { FleetSummarySiteOutcome } from '@gscdump/sdk/fleet-summary'
import { buildFleetSummary, computeFleetDeltas } from '@gscdump/sdk/fleet-summary'
import { describe, expect, it } from 'vitest'

const window = {
  startDate: '2026-11-16',
  endDate: '2026-11-22',
  days: 7,
  comparison: { startDate: '2026-11-09', endDate: '2026-11-15' },
}

function okSite(overrides: Partial<Extract<FleetSummarySiteOutcome, { _tag: 'Ok' }>> & { siteId: string, siteUrl: string }): FleetSummarySiteOutcome {
  const totals = overrides.totals ?? { clicks: 100, impressions: 1000, ctr: 0.1, position: 5 }
  const previousTotals = overrides.previousTotals
  return {
    _tag: 'Ok',
    gscProperty: overrides.siteUrl,
    partner: null,
    syncStatus: 'idle',
    oldestDateSynced: '2026-01-01',
    newestDateSynced: '2026-11-22',
    coverage: { startDate: '2026-11-16', endDate: '2026-11-22', complete: true },
    totals,
    ...(previousTotals ? { previousTotals, deltas: computeFleetDeltas(totals, previousTotals) } : {}),
    ...overrides,
  }
}

describe('buildFleetSummary', () => {
  it('deduplicates sameSiteUrlAs hosts by picking complete and widest coverage', () => {
    const partial = okSite({
      siteId: 's_partner',
      siteUrl: 'https://nuxtseo.com/',
      partner: 'nuxtseo',
      coverage: { startDate: '2026-11-20', endDate: '2026-11-22', complete: false },
      totals: { clicks: 40, impressions: 400, ctr: 0.1, position: 6 },
      previousTotals: { clicks: 50, impressions: 500, ctr: 0.1, position: 6 },
    })
    const complete = okSite({
      siteId: 's_native',
      siteUrl: 'https://nuxtseo.com/',
      partner: null,
      coverage: { startDate: '2026-11-16', endDate: '2026-11-22', complete: true },
      totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 4 },
      previousTotals: { clicks: 80, impressions: 800, ctr: 0.1, position: 5 },
    })
    const second = okSite({
      siteId: 's_other',
      siteUrl: 'https://gscdump.com/',
      totals: { clicks: 50, impressions: 1000, ctr: 0.05, position: 8 },
      previousTotals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 7 },
    })

    const summary = buildFleetSummary({
      window,
      searchType: 'web',
      sortBy: 'clicksDelta',
      sortDir: 'asc',
      sites: [partial, complete, second],
    })

    // Biggest drop first: s_other (-50), s_partner (-10), s_native (+20)
    expect(summary.sites.map(s => s.siteId)).toEqual(['s_other', 's_partner', 's_native'])
    expect(summary.sites.find(s => s.siteId === 's_native')?.sameSiteUrlAs).toEqual(['s_partner'])
    expect(summary.sites.find(s => s.siteId === 's_partner')?.sameSiteUrlAs).toEqual(['s_native'])

    // Deduplicated totals count nuxtseo.com once (using s_native) + gscdump.com
    expect(summary.deduplicatedTotals).toMatchObject({
      _tag: 'Complete',
      uniqueSiteUrls: 2,
      includedSiteIds: ['s_native', 's_other'],
      excludedDuplicateSiteIds: ['s_partner'],
      failedSiteIds: [],
      totals: { clicks: 150, impressions: 2000, ctr: 0.075, position: 6 },
      previousTotals: { clicks: 180, impressions: 1800, ctr: 0.1 },
    })
    expect(summary.deduplicatedTotals.deltas?.clicks).toBe(-30)
  })

  it('marks deduplicatedTotals as Partial and keeps non-Ok rows after Ok rows', () => {
    const good = okSite({
      siteId: 's_ok',
      siteUrl: 'https://ok.example.com/',
      totals: { clicks: 20, impressions: 200, ctr: 0.1, position: 3 },
      previousTotals: { clicks: 0, impressions: 0, ctr: 0, position: null },
    })
    const failed: FleetSummarySiteOutcome = {
      _tag: 'Unavailable',
      siteId: 's_err',
      siteUrl: 'https://aaa.example.com/',
      gscProperty: 'https://aaa.example.com/',
      partner: null,
      syncStatus: 'idle',
      oldestDateSynced: '2026-01-01',
      newestDateSynced: '2026-11-22',
      reason: 'DuckDB busy',
      retryable: true,
    }

    const summary = buildFleetSummary({
      window,
      searchType: 'web',
      sortBy: 'clicks',
      sortDir: 'desc',
      sites: [failed, good],
    })

    expect(summary.sites.map(s => s.siteId)).toEqual(['s_ok', 's_err'])
    expect(summary.deduplicatedTotals._tag).toBe('Partial')
    expect(summary.deduplicatedTotals.failedSiteIds).toEqual(['s_err'])
    // Zero-baseline percentage delta stays null instead of Infinity
    expect(summary.sites[0]?._tag === 'Ok' && summary.sites[0].deltas?.clicksPct).toBeNull()
  })
})
