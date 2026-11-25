import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFleetSummary, computeFleetDeltas } from '@gscdump/sdk/fleet-summary'
import { describe, expect, it } from 'vitest'
import {
  buildHostedFleetRequest,
  parseFleetSort,
  renderFleetSummary,
  resolveHostedSiteTokens,
  runLocalFleetWithStore,
} from '../src/commands/fleet'
import { createLocalStore } from '../src/local-store'

function isoDateOffset(anchor: string, deltaDays: number): string {
  const ms = Date.parse(`${anchor}T00:00:00Z`) + deltaDays * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

describe('gscdump fleet command helpers', () => {
  it('maps kebab-case CLI flags and aliases onto the v1 Fleet summary request', () => {
    const req = buildHostedFleetRequest({
      period: '7D',
      vs: 'prev',
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

  it('rejects unknown sort fields, invalid search types, and conflicting period with custom dates', () => {
    expect(() => parseFleetSort('score')).toThrow(/Unknown --sort/)
    expect(() => buildHostedFleetRequest({ 'search-type': 'bogus' })).toThrow(/Invalid --search-type/)
    expect(() => buildHostedFleetRequest({ period: '7d', start: '2026-10-01', end: '2026-10-07' })).toThrow()
  })

  it('resolves Hosted --sites Site URLs to siteIds and rejects unknown or ambiguous URLs', () => {
    const sites = [
      { siteId: 's_one', siteUrl: 'https://one.example.com/' },
      { siteId: 's_dup_a', siteUrl: 'https://dup.example.com/' },
      { siteId: 's_dup_b', siteUrl: 'https://dup.example.com/' },
    ]
    const manager = { kind: 'gscdump' as const }
    expect(resolveHostedSiteTokens(sites, ['https://one.example.com/', 's_dup_a'], manager)).toEqual(['s_one', 's_dup_a'])
    expect(() => resolveHostedSiteTokens(sites, ['https://missing.example.com/'], manager)).toThrow(/No hosted Site matches/)
    expect(() => resolveHostedSiteTokens(sites, ['https://dup.example.com/'], manager)).toThrow(/Multiple hosted Sites match/)
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

describe('gscdump fleet local Store regressions', () => {
  it('scopes local totals by searchType and rejects invalid searchType', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gscdump-fleet-type-'))
    try {
      const store = createLocalStore({ dataDir: dir })
      const siteUrl = 'https://corpus.example.com/'
      const siteId = store.siteIdFor(siteUrl)

      for (const date of ['2026-11-10', '2026-11-11']) {
        await store.engine.writeDay({ userId: store.userId, siteId, table: 'dates', searchType: 'web', date }, [
          { date, clicks: 10, impressions: 100, sum_position: 400 },
        ])
        await store.engine.writeDay({ userId: store.userId, siteId, table: 'dates', searchType: 'discover', date }, [
          { date, clicks: 500, impressions: 5000, sum_position: 0 },
        ])
      }

      const webSummary = await runLocalFleetWithStore(store, { 'period': '7d', 'vs': 'none', 'search-type': 'web' })
      expect(webSummary.sites[0]?._tag).toBe('Ok')
      if (webSummary.sites[0]?._tag === 'Ok')
        expect(webSummary.sites[0].totals.clicks).toBe(20)

      const discoverSummary = await runLocalFleetWithStore(store, { 'period': '7d', 'vs': 'none', 'search-type': 'discover' })
      expect(discoverSummary.sites[0]?._tag).toBe('Ok')
      if (discoverSummary.sites[0]?._tag === 'Ok')
        expect(discoverSummary.sites[0].totals.clicks).toBe(1000)

      await expect(runLocalFleetWithStore(store, { 'search-type': 'invalid-type' })).rejects.toThrow(/Invalid --search-type/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('aggregates >1000 fallback page rows in SQL without truncation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gscdump-fleet-trunc-'))
    try {
      const store = createLocalStore({ dataDir: dir })
      const siteUrl = 'https://many-pages.example.com/'
      const siteId = store.siteIdFor(siteUrl)

      // 3 days x 450 URLs = 1,350 rows (> default 1,000 LIMIT) in pages table with no dates table.
      for (const date of ['2026-11-20', '2026-11-21', '2026-11-22']) {
        const rows = Array.from({ length: 450 }, (_, idx) => ({
          date,
          url: `https://many-pages.example.com/p/${idx}`,
          clicks: 1,
          impressions: 2,
          sum_position: 10,
        }))
        await store.engine.writeDay({ userId: store.userId, siteId, table: 'pages', searchType: 'web', date }, rows)
      }

      const summary = await runLocalFleetWithStore(store, { period: '7d', vs: 'none' })
      expect(summary.sites[0]?._tag).toBe('Ok')
      if (summary.sites[0]?._tag === 'Ok') {
        expect(summary.sites[0].totals.clicks).toBe(1350)
        expect(summary.sites[0].totals.impressions).toBe(2700)
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('evaluates --trajectory over full preserved history even on a 7d window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gscdump-fleet-traj-'))
    try {
      const store = createLocalStore({ dataDir: dir })
      const siteUrl = 'https://traj.example.com/'
      const siteId = store.siteIdFor(siteUrl)

      // 45 days: high peak early (100 clicks/day), low latest week (10 clicks/day).
      const end = '2026-11-22'
      for (let i = 44; i >= 0; i--) {
        const date = isoDateOffset(end, -i)
        const clicks = i >= 30 ? 100 : 10
        await store.engine.writeDay({ userId: store.userId, siteId, table: 'dates', searchType: 'web', date }, [
          { date, clicks, impressions: clicks * 10, sum_position: clicks * 30 },
        ])
      }

      const summary = await runLocalFleetWithStore(store, { period: '7d', vs: 'none', trajectory: true })
      expect(summary.sites[0]?._tag).toBe('Ok')
      if (summary.sites[0]?._tag === 'Ok') {
        expect(summary.sites[0].trajectory?.classification).not.toBe('insufficient-data')
        expect(summary.sites[0].trajectory?.peakWeekClicks).toBe(700)
        expect(summary.sites[0].trajectory?.latestWeekClicks).toBe(70)
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a 100% click drop as Ok with -100% delta instead of hiding it as Empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gscdump-fleet-drop-'))
    try {
      const store = createLocalStore({ dataDir: dir })
      const siteUrl = 'https://dropped.example.com/'
      const siteId = store.siteIdFor(siteUrl)

      // Previous week (Nov 9-15) had 100 clicks/day; current week (Nov 16-22) is synced with zero rows.
      for (let d = 9; d <= 15; d++) {
        const date = `2026-11-${String(d).padStart(2, '0')}`
        await store.engine.writeDay({ userId: store.userId, siteId, table: 'dates', searchType: 'web', date }, [
          { date, clicks: 100, impressions: 1000, sum_position: 4000 },
        ])
      }
      for (let d = 16; d <= 22; d++) {
        const date = `2026-11-${String(d).padStart(2, '0')}`
        await store.engine.writeDay({ userId: store.userId, siteId, table: 'dates', searchType: 'web', date }, [])
      }

      const summary = await runLocalFleetWithStore(store, { period: '7d', vs: 'prev-period', sort: 'clicks-delta', asc: true })
      expect(summary.sites[0]?._tag).toBe('Ok')
      if (summary.sites[0]?._tag === 'Ok') {
        expect(summary.sites[0].totals.clicks).toBe(0)
        expect(summary.sites[0].previousTotals?.clicks).toBe(700)
        expect(summary.sites[0].deltas?.clicks).toBe(-700)
        expect(summary.sites[0].deltas?.clicksPct).toBe(-100)
      }
      expect(summary.deduplicatedTotals.previousTotals?.clicks).toBe(700)
      expect(summary.deduplicatedTotals.deltas?.clicks).toBe(-700)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
