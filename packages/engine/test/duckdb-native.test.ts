import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createDuckDBCodec, createDuckDBExecutor } from '@gscdump/engine'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { afterEach, describe, expect, it } from 'vitest'
import { createInMemoryDataSource } from './helpers/in-memory'

afterEach(resetNodeDuckDB)

describe('native DuckDB handle', () => {
  it('keeps the last value when SQL repeats a column name', async () => {
    const handle = createNodeDuckDBHandle()
    expect(await handle.query('SELECT 1 AS clicks, 2 AS clicks')).toEqual([{ clicks: 2 }])
  })

  it('preserves exact integers, dates, nested values, and JSON functions', async () => {
    const handle = createNodeDuckDBHandle()
    const rows = await handle.query(`SELECT
      9007199254740993::BIGINT AS exact,
      DATE '2026-04-10' AS date,
      TIMESTAMP '2026-04-10 12:30:00.123' AS timestamp,
      1.25::DECIMAL(10,2) AS fraction,
      {'days': [DATE '2026-04-10'], 'count': 7::BIGINT} AS nested,
      to_json({'url': '/日本語'}) AS json`)
    expect(rows).toEqual([{
      exact: 9007199254740993n,
      date: Date.parse('2026-04-10'),
      timestamp: Date.parse('2026-04-10T12:30:00.123Z'),
      fraction: 1.25,
      nested: { days: [Date.parse('2026-04-10')], count: 7n },
      json: '{"url":"/日本語"}',
    }])
  })

  it('binds dates and bytes without SQL interpolation', async () => {
    const handle = createNodeDuckDBHandle()
    expect(await handle.query('SELECT $1::TIMESTAMP AS date, $2::BLOB AS bytes', [
      new Date('2026-04-10T12:30:00.123Z'),
      new Uint8Array([0, 39, 255]),
    ])).toEqual([{
      date: Date.parse('2026-04-10T12:30:00.123Z'),
      bytes: new Uint8Array([0, 39, 255]),
    }])
  })

  it('drains accepted queries before reset and keeps a held handle usable', async () => {
    const handle = createNodeDuckDBHandle()
    const created = handle.query('CREATE TEMP TABLE pending AS SELECT 42 AS answer')
    const selected = handle.query('SELECT * FROM pending')
    resetNodeDuckDB()
    await created
    expect(await selected).toEqual([{ answer: 42 }])
    expect(await handle.query('SELECT 7 AS answer')).toEqual([{ answer: 7 }])
    await expect(handle.query('SELECT * FROM pending')).rejects.toThrow(/pending/)
    expect(await handle.query('SELECT 8 AS answer')).toEqual([{ answer: 8 }])
  })

  it('cleans registered buffers when a query fails', async () => {
    const handle = createNodeDuckDBHandle()
    const directory = dirname(handle.makeTempPath('parquet'))
    const dataSource = createInMemoryDataSource()
    const factory = { getDuckDB: async () => handle }
    const codec = createDuckDBCodec(factory)
    await codec.writeRows({ table: 'pages' }, [
      { url: '/one', date: '2026-04-10', clicks: 7, impressions: 100, sum_position: 300 },
    ], 'nested/quoted\'file.parquet', dataSource)
    await expect(createDuckDBExecutor(factory).execute({
      sql: 'SELECT missing_column FROM read_parquet({{FILES}})',
      params: [],
      fileKeys: { FILES: ['nested/quoted\'file.parquet'] },
      table: 'pages',
      dataSource,
    })).rejects.toThrow(/missing_column/)
    expect(await readdir(directory)).toEqual([])
  })

  it('writes Parquet readable by the browser WASM binary', async () => {
    const handle = createNodeDuckDBHandle()
    const dataSource = createInMemoryDataSource()
    const rows = [{ url: '/日本語', date: '2026-04-10', clicks: 7, impressions: 100, sum_position: 300 }]
    await createDuckDBCodec({ getDuckDB: async () => handle }).writeRows({ table: 'pages' }, rows, 'data.parquet', dataSource)
    const require = createRequire(import.meta.url)
    const { createDuckDB, NODE_RUNTIME, VoidLogger } = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs')
    const wasm = await createDuckDB({
      mvp: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm') },
      eh: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm') },
    }, new VoidLogger(), NODE_RUNTIME)
    await wasm.instantiate()
    const connection = wasm.connect()
    try {
      wasm.registerFileBuffer('native.parquet', await dataSource.read('data.parquet'))
      const result = connection.query(`SELECT url, date::VARCHAR AS date,
        clicks::INT AS clicks, impressions::INT AS impressions, sum_position
        FROM read_parquet('native.parquet')`)
      expect(result.toArray().map((row: { toJSON: () => unknown }) => row.toJSON())).toEqual(rows)
    }
    finally {
      connection.close()
      wasm.reset()
    }
  })

  it('refuses file operations outside its temporary directory', async () => {
    const handle = createNodeDuckDBHandle()
    const owned = handle.makeTempPath('json')
    await handle.registerFileBuffer(owned, new Uint8Array([42]))
    const escaped = join(dirname(owned), '..', 'caller-file.json')
    await expect(handle.registerFileBuffer(escaped, new Uint8Array([0]))).rejects.toThrow(/temporary directory/)
    await expect(handle.dropFiles([escaped])).rejects.toThrow(/temporary directory/)
    expect(new Uint8Array(await readFile(owned))).toEqual(new Uint8Array([42]))
    await handle.dropFiles([owned])
  })
})
