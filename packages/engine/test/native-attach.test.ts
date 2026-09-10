import type { DuckDBConnection, DuckDBInstance as Instance } from '@duckdb/node-api'
import type { SnapshotQueryRunner } from '@gscdump/engine/node'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { encodeRowsToParquet } from '@gscdump/engine/hyparquet'
import { attachParquetIndex, attachSnapshotIndex } from '@gscdump/engine/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const index = { version: 1 as const, builtAt: '2026-09-10', cold: ['2026-08'], hot: true, hotDays: 3 }

describe('native local attachments', () => {
  let directory: string
  let instance: Instance
  let connection: DuckDBConnection
  let runner: SnapshotQueryRunner

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gscdump-native-attach-'))
    instance = await DuckDBInstance.create(':memory:', {
      extension_directory: join(directory, 'extensions'),
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    })
    connection = await instance.connect()
    runner = async sql => (await connection.runAndReadAll(sql)).getRowObjectsJS()
  })

  afterEach(async () => {
    connection.closeSync()
    instance.closeSync()
    await rm(directory, { recursive: true, force: true })
  })

  it('queries attached local Parquet without an installed httpfs extension', async () => {
    const parquet = join(directory, 'local.parquet')
    await writeFile(parquet, encodeRowsToParquet('pages', [{
      url: '/local',
      date: '2026-09-01',
      clicks: 7,
      impressions: 100,
      sum_position: 300,
    }]))

    await attachParquetIndex(runner, { tables: { pages: [parquet] } })

    expect(await runner('SELECT url, clicks::INT AS clicks FROM pages')).toEqual([{ url: '/local', clicks: 7 }])
  })

  it('queries local cold and hot snapshots without installing httpfs for unused remote URLs', async () => {
    async function createSnapshot(filename: string, url: string, clicks: number) {
      const path = join(directory, filename)
      const snapshot = await DuckDBInstance.create(path)
      const writer = await snapshot.connect()
      try {
        await writer.run('CREATE TABLE pages AS SELECT $1::VARCHAR AS url, $2::INT AS clicks', [url, clicks])
      }
      finally {
        writer.closeSync()
        snapshot.closeSync()
      }
      return path
    }
    const cold = await createSnapshot('cold-2026-08.duckdb', '/cold', 3)
    const hot = await createSnapshot('hot.duckdb', '/hot', 7)

    await attachSnapshotIndex(runner, {
      index,
      attachUrls: {
        'cold-2026-08.duckdb': cold,
        'hot.duckdb': hot,
        'unused.duckdb': 'https://example.invalid/unused.duckdb',
      },
    })

    expect(await runner('SELECT url, clicks FROM pages ORDER BY url')).toEqual([
      { url: '/cold', clicks: 3 },
      { url: '/hot', clicks: 7 },
    ])
  })

  it.each(['http', 'https', 's3'])('reports the missing httpfs extension for %s Parquet', async (scheme) => {
    const result = attachParquetIndex(runner, {
      tables: { pages: [`${scheme}://example.invalid/local.parquet`] },
      forceDownload: false,
    })

    await expect(result).rejects.toMatchObject({
      message: 'Remote files require the DuckDB httpfs extension. Install httpfs before attaching remote files.',
      cause: expect.any(Error),
    })
  })

  it.each(['http', 'https', 's3'])('reports the missing httpfs extension for %s snapshots', async (scheme) => {
    const result = attachSnapshotIndex(runner, {
      index: { ...index, cold: [] },
      attachUrls: { 'hot.duckdb': `${scheme}://example.invalid/hot.duckdb` },
      forceDownload: false,
    })

    await expect(result).rejects.toMatchObject({
      message: 'Remote files require the DuckDB httpfs extension. Install httpfs before attaching remote files.',
      cause: expect.any(Error),
    })
  })
})
