import type { DataSource } from '@gscdump/engine'
import { createHyparquetCodec, decodeParquetToRows, encodeRowsToParquetFlex } from '@gscdump/engine/hyparquet'
import { describe, expect, it } from 'vitest'

describe('parquet date decoding', () => {
  it('normalizes dates after a null first row across row groups', async () => {
    const rows = [
      { date: null, other_date: '2026-04-01', label: 'first' },
      { date: '2026-04-02', other_date: null, label: 'second' },
      { date: '2026-04-02', other_date: '1969-12-31', label: 'third' },
    ]
    const bytes = encodeRowsToParquetFlex(rows, {
      columns: [
        { name: 'date', type: 'DATE', nullable: true },
        { name: 'other_date', type: 'DATE', nullable: true },
        { name: 'label', type: 'VARCHAR', nullable: false },
      ],
      rowGroupSize: 2,
    })
    expect(await decodeParquetToRows(bytes)).toEqual(rows)
    expect(await decodeParquetToRows(bytes, { columns: ['date'], rowStart: 0, rowEnd: 2 }))
      .toEqual([{ date: null }, { date: '2026-04-02' }])
  })

  it('preserves dates when a file exceeds the date cache capacity', async () => {
    const rows = Array.from({ length: 1030 }, (_, i) => ({ date: new Date(i * 86_400_000).toISOString().slice(0, 10) }))
    rows.push(rows[0]!)
    const bytes = encodeRowsToParquetFlex(rows, {
      columns: [{ name: 'date', type: 'DATE', nullable: false }],
      rowGroupSize: 2000,
    })
    expect(await decodeParquetToRows(bytes)).toEqual(rows)
  })
})

describe('parquet row groups', () => {
  const columns = [
    { name: 'date', type: 'DATE', nullable: false },
    { name: 'url', type: 'VARCHAR', nullable: false },
    { name: 'clicks', type: 'BIGINT', nullable: false },
    { name: 'impressions', type: 'BIGINT', nullable: false },
    { name: 'sum_position', type: 'DOUBLE', nullable: false },
  ] as const
  const rows = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-04-0${i + 1}`,
    url: `/page/${i}`,
    clicks: BigInt(i),
    impressions: BigInt(i * 10),
    sum_position: i + 0.5,
  }))

  it('preserves physical order and ranges across row groups', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns, rowGroupSize: 2 })
    expect(await decodeParquetToRows(bytes)).toEqual(rows)
    expect(await decodeParquetToRows(bytes, { rowStart: 1, rowEnd: 6 })).toEqual(rows.slice(1, 6))
    expect(await decodeParquetToRows(bytes, { rowStart: 7 })).toEqual([])
    expect(await decodeParquetToRows(bytes, { rowStart: 2, rowEnd: 2 })).toEqual([])
    expect(await decodeParquetToRows(bytes, { columns: ['absent'], rowStart: 1, rowEnd: 4 })).toEqual([{}, {}, {}])
  })

  it('preserves Date filters when projecting another column across groups', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns, rowGroupSize: 2 })
    expect(await decodeParquetToRows(bytes, {
      columns: ['url', 'absent'],
      rowStart: 1,
      rowEnd: 6,
      filter: { date: { $gte: new Date('2026-04-03T00:00:00Z') } },
    })).toEqual(rows.slice(2, 6).map(row => ({ url: row.url })))
  })

  it('keeps the last natural key across groups and input files', async () => {
    const files = new Map<string, Uint8Array>([
      ['first', encodeRowsToParquetFlex([...rows, { ...rows[0]!, clicks: 88n }], { columns, rowGroupSize: 2 })],
      ['last', encodeRowsToParquetFlex([{ ...rows[1]!, clicks: 99n }], { columns, rowGroupSize: 2 })],
    ])
    const source: DataSource = {
      async read(key) {
        const bytes = files.get(key)
        if (!bytes)
          throw new Error(`Missing file: ${key}`)
        return bytes
      },
      async write(key, bytes) { files.set(key, bytes) },
      async delete(keys) { keys.forEach(key => files.delete(key)) },
      async list() { return [...files.keys()] },
    }
    const codec = createHyparquetCodec()
    const result = await codec.compactRows({ table: 'pages' }, ['first', 'last'], 'output', source)
    expect(result.rowCount).toBe(rows.length)
    const decoded = await codec.readRows({ table: 'pages' }, 'output', source)
    expect(decoded.map(({ date, url, clicks, impressions, sum_position }) => ({ date, url, clicks, impressions, sum_position })))
      .toEqual(rows.map((row, i) => ({ ...row, clicks: i === 0 ? 88 : i === 1 ? 99 : Number(row.clicks), impressions: Number(row.impressions) })))
  })

  it('preserves distinct keys with embedded separators and later replacements', async () => {
    // Every split has the same delimiter-joined key. Field boundaries must
    // remain distinct, including when many keys share an index bucket.
    const parts = 'abcdefghijk'.split('')
    const distinct = Array.from({ length: 10 }, (_, i) => ({
      date: '2026-04-01',
      url: parts.slice(0, i + 1).join('\0'),
      query: parts.slice(i + 1).join('\0'),
      clicks: i,
      impressions: 100,
      sum_position: 10,
    }))
    const initial = [...distinct.slice(0, 3), { ...distinct[2]!, clicks: 102 }, ...distinct.slice(3)]
    const replacement = [{ ...distinct[1]!, clicks: 101 }, { ...distinct[9]!, clicks: 109 }]
    const files = new Map<string, Uint8Array>()
    const source: DataSource = {
      async read(key) {
        const bytes = files.get(key)
        if (!bytes)
          throw new Error(`Missing file: ${key}`)
        return bytes
      },
      async write(key, bytes) { files.set(key, bytes) },
      async delete(keys) { keys.forEach(key => files.delete(key)) },
      async list() { return [...files.keys()] },
    }
    const codec = createHyparquetCodec()
    await codec.writeRows({ table: 'page_queries' }, initial, 'first', source)
    await codec.writeRows({ table: 'page_queries' }, replacement, 'last', source)
    expect(await codec.compactRows({ table: 'page_queries' }, ['first', 'last'], 'output', source))
      .toMatchObject({ rowCount: 10 })
    const decoded = await codec.readRows({ table: 'page_queries' }, 'output', source)
    for (const [i, row] of distinct.entries()) {
      expect(decoded.find(candidate => candidate.url === row.url && candidate.query === row.query))
        .toMatchObject({ ...row, clicks: i === 1 || i === 2 || i === 9 ? i + 100 : i })
    }
  })
})
