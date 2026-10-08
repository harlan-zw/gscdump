import { readFile } from 'node:fs/promises'
import { createHyparquetCodec, decodeParquetToRows } from '@gscdump/engine/hyparquet'
import { describe, expect, it } from 'vitest'

// DuckDB 1.5.5 COPY output with COMPRESSION ZSTD. Includes partition keys,
// native DATE, BIGINT, DOUBLE, and a null metric as catalog compaction writes do.
async function fixtureBytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL('./fixtures/pages-zstd.parquet', import.meta.url)))
}

const expected = [
  { site_id: 11, search_type: 0, date: '2026-10-01', url: 'https://example.com/a', clicks: 3n, impressions: 20n, sum_position: 30 },
  { site_id: 11, search_type: 0, date: '2026-10-02', url: 'https://example.com/b', clicks: 5n, impressions: 40n, sum_position: 80 },
  { site_id: 11, search_type: 0, date: '2026-10-03', url: 'https://example.com/c', clicks: 0n, impressions: 10n, sum_position: null },
]

describe('catalog parquet compressed with ZSTD', () => {
  it('decodes compacted metrics and partition keys', async () => {
    expect(await decodeParquetToRows(await fixtureBytes())).toEqual(expected)
  })

  it('keeps projection and row filtering on compressed columns', async () => {
    const rows = await decodeParquetToRows(await fixtureBytes(), {
      columns: ['date', 'url', 'clicks', 'missing_column'],
      filter: { url: { $eq: 'https://example.com/b' } },
    })
    expect(rows).toEqual([{ date: '2026-10-02', url: 'https://example.com/b', clicks: 5n }])
  })

  it('keeps physical row bounds on compressed columns', async () => {
    expect(await decodeParquetToRows(await fixtureBytes(), { rowStart: 1, rowEnd: 2 })).toEqual([expected[1]])
  })

  it('reads compressed files through the storage codec', async () => {
    const bytes = await fixtureBytes()
    const rows = await createHyparquetCodec().readRows({ table: 'pages' }, 'pages.parquet', {
      read: async () => bytes,
      write: async () => {},
      list: async () => [],
      delete: async () => {},
    })
    expect(rows).toEqual(expected)
  })
})
