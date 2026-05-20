import type { ManifestEntry, SearchType } from '../src/storage'
import { describe, expect, it } from 'vitest'
import { dedupeOverlappingTiers, splitOverlappingTiers } from '../src/compaction'

function entry(partition: string, opts: { searchType?: SearchType, createdAt?: number } = {}): ManifestEntry {
  return {
    userId: '1',
    siteId: 's',
    table: 'pages',
    partition,
    objectKey: `key/${opts.searchType ?? 'web'}/${partition}`,
    rowCount: 1,
    bytes: 1,
    createdAt: opts.createdAt ?? 1,
    ...(opts.searchType ? { searchType: opts.searchType } : {}),
  }
}

const partitions = (entries: ManifestEntry[]) => entries.map(e => e.partition).sort()

describe('dedupeOverlappingTiers', () => {
  it('regression: unlighthouse.dev live manifest — drops only the subsumed monthly/2026-04', () => {
    // The exact live keywords-table partition set captured from prod
    // (gscdump.com) during the impressions over-count investigation. The
    // backfilled monthly/2026-04 sat live alongside weekly/2026-04-* covering
    // the same days, so `union_by_name` double-counted April. monthly/2026-03
    // must stay (Mar 1-29 is covered by nothing finer).
    const manifest = [
      'daily/2026-05-11',
      'daily/2026-05-12',
      'daily/2026-05-13',
      'daily/2026-05-14',
      'daily/2026-05-15',
      'daily/2026-05-16',
      'daily/2026-05-17',
      'daily/2026-05-18',
      'monthly/2026-01',
      'monthly/2026-02',
      'monthly/2026-03',
      'monthly/2026-04',
      'quarterly/2024-Q4',
      'quarterly/2025-Q3',
      'quarterly/2025-Q4',
      'weekly/2026-03-30',
      'weekly/2026-04-06',
      'weekly/2026-04-13',
      'weekly/2026-04-20',
      'weekly/2026-04-27',
      'weekly/2026-05-04',
    ].map(p => entry(p))
    const { kept, subsumed } = splitOverlappingTiers(manifest)
    expect(subsumed.map(e => e.partition)).toEqual(['monthly/2026-04'])
    expect(kept).toHaveLength(20)
    expect(partitions(kept)).toContain('monthly/2026-03')
  })

  it('drops a monthly fully subsumed by weekly files', () => {
    // weekly/2026-03-30 (Mar 30 - Apr 5) through weekly/2026-04-27 (Apr 27 - May 3)
    // fully tile April.
    const weeks = ['weekly/2026-03-30', 'weekly/2026-04-06', 'weekly/2026-04-13', 'weekly/2026-04-20', 'weekly/2026-04-27']
    const kept = dedupeOverlappingTiers([entry('monthly/2026-04'), ...weeks.map(entry)])
    expect(partitions(kept)).not.toContain('monthly/2026-04')
    expect(partitions(kept)).toEqual(weeks.sort())
  })

  it('keeps a monthly when finer tiers only partially cover it', () => {
    const kept = dedupeOverlappingTiers([entry('monthly/2026-03'), entry('weekly/2026-03-30')])
    // weekly/2026-03-30 (Mar 30 - Apr 5) leaves Mar 1-29 uncovered.
    expect(partitions(kept)).toContain('monthly/2026-03')
    expect(partitions(kept)).toContain('weekly/2026-03-30')
  })

  it('drops a quarterly fully subsumed by monthly files', () => {
    const months = ['monthly/2025-10', 'monthly/2025-11', 'monthly/2025-12']
    const kept = dedupeOverlappingTiers([entry('quarterly/2025-Q4'), ...months.map(entry)])
    expect(partitions(kept)).toEqual(months.sort())
  })

  it('always keeps the finest tier (daily)', () => {
    const kept = dedupeOverlappingTiers([entry('monthly/2026-05'), entry('daily/2026-05-10')])
    expect(partitions(kept)).toContain('daily/2026-05-10')
  })

  it('passes through partitions with no date span unchanged', () => {
    const kept = dedupeOverlappingTiers([entry('hourly/2026-05-10'), entry('monthly/2026-05')])
    expect(partitions(kept)).toEqual(['hourly/2026-05-10', 'monthly/2026-05'])
  })

  it('leaves non-overlapping tiers intact', () => {
    const input = ['monthly/2026-01', 'monthly/2026-02', 'daily/2026-05-18']
    const kept = dedupeOverlappingTiers(input.map(entry))
    expect(partitions(kept)).toEqual(input.sort())
  })

  it('never cancels tiers across searchTypes', () => {
    // A web monthly and a discover weekly cover disjoint data — keep both.
    const kept = dedupeOverlappingTiers([
      entry('monthly/2026-03', { searchType: 'web' }),
      entry('daily/2026-03-10', { searchType: 'discover' }),
    ])
    expect(kept).toHaveLength(2)
  })

  it('reports subsumed entries and prefers the newest same-partition version', () => {
    const stale = entry('monthly/2026-05', { createdAt: 100 })
    const fresh = entry('monthly/2026-05', { createdAt: 200 })
    const { kept, subsumed } = splitOverlappingTiers([stale, fresh])
    expect(kept).toEqual([fresh])
    expect(subsumed).toEqual([stale])
  })
})
