import {
  createGscdumpV1Protocol,
  fleetSummarySortFormula,
  fleetSummaryV1DataSchemas,
  fleetSummaryV1RequestSchema,
} from '@gscdump/contracts/v1/http'
import { describe, expect, it } from 'vitest'

describe('analytics.fleet.summary.query v1 contract', () => {
  it('registers the Fleet summary operation on the analytics surface', () => {
    const protocol = createGscdumpV1Protocol()
    const op = protocol.surfaces.analytics.operations.queryFleetSummary
    expect(op.id).toBe('analytics.fleet.summary.query')
    expect(op.method).toBe('POST')
    expect(op.path).toBe('/fleet/summary')
  })

  it('applies defaults for period, comparison, searchType, and sort', () => {
    const parsed = fleetSummaryV1RequestSchema.parse({})
    expect(parsed).toEqual({
      period: 'last-28d',
      comparison: 'prev-period',
      searchType: 'web',
      sortBy: 'clicks',
      sortDir: 'desc',
    })
  })

  it.each([
    { label: 'custom without dates', input: { period: 'custom' } },
    { label: 'startDate without endDate', input: { period: 'custom', startDate: '2026-11-01' } },
    { label: 'inverted range', input: { period: 'custom', startDate: '2026-11-10', endDate: '2026-11-01' } },
    { label: 'empty siteIds', input: { siteIds: [] } },
    { label: 'unknown sortBy', input: { sortBy: 'score' } },
  ])('rejects invalid request: $label', ({ input }) => {
    expect(fleetSummaryV1RequestSchema.safeParse(input).success).toBe(false)
  })

  it('parses Ok, Empty, NotSynced, and Unavailable Site rows with Partial totals', () => {
    const payload = {
      window: {
        startDate: '2026-11-16',
        endDate: '2026-11-22',
        days: 7,
        comparison: { startDate: '2026-11-09', endDate: '2026-11-15' },
      },
      searchType: 'web',
      sortBy: 'clicksDelta',
      sortDir: 'asc',
      sortFormula: fleetSummarySortFormula('clicksDelta', 'asc'),
      sites: [
        {
          _tag: 'Ok',
          siteId: 's_01',
          siteUrl: 'https://example.com/',
          gscProperty: 'sc-domain:example.com',
          partner: null,
          sameSiteUrlAs: [],
          syncStatus: 'idle',
          oldestDateSynced: '2025-07-01',
          newestDateSynced: '2026-11-22',
          coverage: { startDate: '2026-11-16', endDate: '2026-11-22', complete: true },
          totals: { clicks: 120, impressions: 2400, ctr: 0.05, position: 8.4 },
          previousTotals: { clicks: 200, impressions: 2500, ctr: 0.08, position: 7.2 },
          deltas: { clicks: -80, clicksPct: -40, impressions: -100, impressionsPct: -4, ctr: -0.03, position: 1.2 },
        },
        {
          _tag: 'NotSynced',
          siteId: 's_02',
          siteUrl: 'https://new.example.com/',
          gscProperty: 'https://new.example.com/',
          partner: 'nuxtseo',
          sameSiteUrlAs: [],
          syncStatus: 'pending',
          oldestDateSynced: null,
          newestDateSynced: null,
          reason: 'Initial sync has not completed.',
        },
        {
          _tag: 'Unavailable',
          siteId: 's_03',
          siteUrl: 'https://flaky.example.com/',
          gscProperty: 'https://flaky.example.com/',
          partner: null,
          sameSiteUrlAs: [],
          syncStatus: 'idle',
          oldestDateSynced: '2026-01-01',
          newestDateSynced: '2026-11-22',
          reason: 'Analytics read timed out.',
          retryable: true,
        },
      ],
      deduplicatedTotals: {
        _tag: 'Partial',
        uniqueSiteUrls: 3,
        includedSiteIds: ['s_01'],
        excludedDuplicateSiteIds: [],
        failedSiteIds: ['s_02', 's_03'],
        totals: { clicks: 120, impressions: 2400, ctr: 0.05, position: 8.4 },
        previousTotals: { clicks: 200, impressions: 2500, ctr: 0.08, position: 7.2 },
        deltas: { clicks: -80, clicksPct: -40, impressions: -100, impressionsPct: -4, ctr: -0.03, position: 1.2 },
      },
    }

    const parsed = fleetSummaryV1DataSchemas.producer.parse(payload)
    expect(parsed.sites.map(s => s._tag)).toEqual(['Ok', 'NotSynced', 'Unavailable'])
    expect(parsed.deduplicatedTotals._tag).toBe('Partial')
  })
})
