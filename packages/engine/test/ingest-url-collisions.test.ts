import type { TableName } from '@gscdump/engine/contracts'
import type { GscApiRow } from '@gscdump/engine/ingest'
import { createStorageEngine } from '@gscdump/engine'
import { createRowAccumulator } from '@gscdump/engine/ingest'
import { createIngestAccumulator } from '@gscdump/engine/ingest-accumulator'
import { describe, expect, it } from 'vitest'
import { createInMemoryDataSource, createInMemoryManifestStore, createJsonCodec, createUnionExecutor } from './helpers/in-memory'

const day = '2026-09-01'
const query = 'blue widgets'
const appearance = 'AMP_TOP_STORIES'
const tables: TableName[] = ['pages', 'page_queries', 'search_appearance_pages', 'search_appearance_page_queries', 'hourly_pages']

function sourceRow(table: TableName, url: string, clicks = 2, impressions = 10, position = 2, date = day): GscApiRow {
  const keys = table === 'hourly_pages'
    ? [`${date}T08:00:00-07:00`, url]
    : table === 'page_queries' || table === 'search_appearance_page_queries'
      ? [url, query, date]
      : [url, date]
  return { keys, clicks, impressions, position }
}

function collidingRows(table: TableName): GscApiRow[] {
  return [
    sourceRow(table, 'https://example.com/guide#first'),
    sourceRow(table, 'https://docs.example.com/guide?ref=second#next', 3, 20, 4),
  ]
}

describe('uRL metrics at the ingest boundary', () => {
  it.each(tables)('combines distinct Google URLs in %s and counts repeated source rows once', (table) => {
    const rows = collidingRows(table)
    const accumulator = createRowAccumulator({ searchAppearance: appearance })
    accumulator.push(table, [rows[0]!])
    accumulator.push(table, [rows[1]!, rows[0]!, rows[1]!])

    expect(accumulator.drain().get(table)?.get(day)).toEqual([{
      url: '/guide',
      date: day,
      clicks: 5,
      impressions: 30,
      sum_position: 70,
      ...(table.includes('queries') ? { query } : {}),
      ...(table.startsWith('search_appearance') ? { searchAppearance: appearance } : {}),
      ...(table === 'hourly_pages' ? { hour: 8 } : {}),
    }])
  })

  it('uses the latest metrics for a repeated raw URL before combining URL variants', () => {
    const accumulator = createRowAccumulator()
    accumulator.push('pages', collidingRows('pages'))
    accumulator.push('pages', [sourceRow('pages', 'https://example.com/guide#first', 4, 15, 3)])

    expect(accumulator.drain().get('pages')?.get(day)).toEqual([{
      url: '/guide',
      date: day,
      clicks: 7,
      impressions: 35,
      sum_position: 90,
    }])
  })

  it('counts distinct URL identities even when their metrics match', () => {
    const accumulator = createRowAccumulator()
    accumulator.push('pages', [
      sourceRow('pages', 'https://example.com/guide#first'),
      sourceRow('pages', 'https://example.com/guide#second'),
    ])

    expect(accumulator.drain().get('pages')?.get(day)).toEqual([{
      url: '/guide',
      date: day,
      clicks: 4,
      impressions: 20,
      sum_position: 20,
    }])
  })

  it('keeps separate queries and hours when their URL paths match', () => {
    const accumulator = createRowAccumulator()
    const pageQuery = sourceRow('page_queries', 'https://example.com/guide')
    const hourly = sourceRow('hourly_pages', 'https://example.com/guide')
    accumulator.push('page_queries', [pageQuery, { ...pageQuery, keys: [pageQuery.keys[0]!, 'red widgets', day] }])
    accumulator.push('hourly_pages', [hourly, { ...hourly, keys: [`${day}T09:00:00-07:00`, hourly.keys[1]!] }])

    const rows = accumulator.drain()
    expect(rows.get('page_queries')?.get(day)?.map(row => [row.query, row.impressions])).toEqual([
      ['blue widgets', 10],
      ['red widgets', 10],
    ])
    expect(rows.get('hourly_pages')?.get(day)?.map(row => [row.hour, row.impressions])).toEqual([
      [8, 10],
      [9, 10],
    ])
  })

  it('combines completed dates and resets raw URL identity after draining', () => {
    const accumulator = createRowAccumulator({ trackDateBoundary: true, maxRows: 3 })
    accumulator.push('pages', collidingRows('pages'))
    accumulator.push('pages', [sourceRow('pages', 'https://example.com/next', 1, 5, 2, '2026-09-02')])

    expect(accumulator.drainCompleted().get('pages')?.get(day)).toEqual([{
      url: '/guide',
      date: day,
      clicks: 5,
      impressions: 30,
      sum_position: 70,
    }])
    expect(accumulator.totalRows).toBe(1)
    accumulator.drain()
    expect(accumulator.push('pages', collidingRows('pages'))).toBe(true)
    expect(accumulator.drain().get('pages')?.get(day)).toEqual([{
      url: '/guide',
      date: day,
      clicks: 5,
      impressions: 30,
      sum_position: 70,
    }])
  })

  it('bounds distinct raw URL identities even when they share one path', () => {
    const accumulator = createRowAccumulator({ maxRows: 2 })
    const first = sourceRow('pages', 'https://example.com/guide#first')
    expect(accumulator.push('pages', [first, first])).toBe(true)
    expect(accumulator.push('pages', [sourceRow('pages', 'https://example.com/guide#second')])).toBe(true)
    expect(accumulator.push('pages', [sourceRow('pages', 'https://example.com/guide#third')])).toBe(false)
    expect(accumulator.overflowed).toBe(true)
    expect(accumulator.totalRows).toBe(3)
  })

  it.each(['pages', 'hourly_pages'] as const)('persists combined %s metrics without doubling repeated syncs', async (table) => {
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const codec = createJsonCodec()
    let now = 0
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor: createUnionExecutor(codec), now: () => ++now })
    const ctx = { userId: 'local', siteId: 'example.com', searchType: 'discover' as const }
    for (let sync = 0; sync < 2; sync++) {
      const accumulator = createIngestAccumulator({
        engine,
        ctx: { ...ctx, grain: table === 'hourly_pages' ? 'hour' : 'day' },
        hooks: { onRecover: async () => false, onWriteError: async ({ error }) => { throw error } },
      })
      const rows = collidingRows(table)
      accumulator.push(table, [...rows, rows[0]!])
      expect(await accumulator.finalize({ hasMore: false })).toMatchObject({ flushed: 1, failed: 0 })
    }

    const [entry] = await engine.listLive({ ...ctx, table })
    const stored = await codec.readRows({ table }, entry!.objectKey, dataSource)
    expect(stored).toEqual([{
      url: '/guide',
      date: day,
      clicks: 5,
      impressions: 30,
      sum_position: 70,
      ...(table === 'hourly_pages' ? { hour: 8 } : {}),
    }])
  })
})
