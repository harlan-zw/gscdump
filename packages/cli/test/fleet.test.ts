import { buildFleetSummary, computeFleetDeltas } from '@gscdump/sdk/fleet-summary'
import { describe, expect, it } from 'vitest'
import { buildHostedFleetRequest, parseFleetSort, renderFleetSummary } from '../src/commands/fleet'

describe('gscdump fleet command helpers', () => {
  it('maps kebab-case CLI flags onto the v1 Fleet summary request', () => {
    const req = buildHostedFleetRequest({
      period: '7d',
      vs: 'prev-period',
      sort: 'clicks-delta',
      asc: true,
      sites: 's_01, s_02',
      indexing: true,
      trajectory: false,
    })
    expect(req).toEqual({
      period: 'last-7d',
      comparison: 'prev-period',
      searchType: 'web',
      siteIds: ['s_01', 's_02'],
      include: { indexing: true, trajectory: false },
      sortBy: 'clicksDelta',
      sortDir: 'asc',
    })
  })

  it('rejects unknown sort fields', () => {
    expect(() => parseFleetSort('score')).toThrow(/Unknown --sort/)
  })

  it('renders Site rows and deduplicated Fleet totals for human output', () => {
    const cur = { clicks: 80, impressions: 1000, ctr: 0.08, position: 6.2 }
    const prev = { clicks: 120, impressions: 1000, ctr: 0.12, position: 5.1 }
    const summary = buildFleetSummary({
      window: {
        startDate: '2026-11-16',
        endDate: '2026-11-22',
        days: 7,
        comparison: { startDate: '2026-11-09', endDate: '2026-11-15' },
      },
      searchType: 'web',
      sortBy: 'clicksDelta',
      sortDir: 'asc',
      sites: [
        {
          _tag: 'Ok',
          siteId: 's_01',
          siteUrl: 'https://example.com/',
          gscProperty: 'sc-domain:example.com',
          partner: null,
          syncStatus: 'idle',
          oldestDateSynced: '2026-01-01',
          newestDateSynced: '2026-11-22',
          coverage: { startDate: '2026-11-16', endDate: '2026-11-22', complete: true },
          totals: cur,
          previousTotals: prev,
          deltas: computeFleetDeltas(cur, prev),
        },
      ],
    })

    const output = renderFleetSummary(summary)
    expect(output).toContain('2026-11-16 to 2026-11-22')
    expect(output).toContain('https://example.com/')
    expect(output).toContain('Fleet total (Complete, 1 unique Sites)')
  })
})
