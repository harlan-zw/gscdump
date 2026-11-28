import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { encodeRowsToParquetFlex } from '@gscdump/engine/hyparquet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'

const site = { siteId: 's_01', siteUrl: 'https://example.com/' }
const datasets = ['google_dates', 'bing_traffic', 'indexnow_submission_receipts']
const parquet = encodeRowsToParquetFlex([{ clicks: 42 }], { columns: [{ name: 'clicks', type: 'INTEGER', nullable: false }] })

describe('hosted dump', () => {
  let directory: string

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-hosted-export-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(directory, { recursive: true, force: true })
  })

  function mockApi(truncated?: string) {
    return vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit) => {
      const headers = new Headers(init.headers)
      const url = new URL(input)
      if (url.pathname === '/api/cli/me') {
        expect(headers.get('x-api-key')).toBe('gsd_user_test')
        return Response.json({ user: { publicId: 'u_01', email: 'person@example.com' }, sites: [site] })
      }
      expect(headers.get('authorization')).toBe('Bearer gsd_user_test')
      const root = '/api/partner/v1/sites/s_01/record-export'
      if (url.pathname === root) {
        return Response.json({
          data: { ...site, generatedAt: '2026-11-28T00:00:00Z', format: 'parquet', datasets: datasets.map(dataset => ({ dataset, file: `${dataset}.parquet`, description: dataset, coverage: 'Retained rows', columns: [] })) },
          meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
        })
      }
      const dataset = datasets.find(dataset => url.pathname === `${root}/${dataset}.parquet`)
      expect(dataset).toBeDefined()
      return new Response(new Uint8Array(truncated === dataset ? parquet.subarray(0, -4) : parquet), { headers: { 'content-type': 'application/vnd.apache.parquet' } })
    }))
  }

  function dump(out: string) {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    return runCli({
      rawArgs: ['--config-dir', directory, 'dump', '--mode', 'hosted', '--site', 'example.com', '--out', out, '--json'],
      environment: { GSCDUMP_API_KEY: 'gsd_user_test', GSCDUMP_API_ROOT: 'https://example.com/api' },
    })
  }

  it('downloads a readable file from each source and records them in the manifest', async () => {
    mockApi()
    const out = path.join(directory, 'export')
    expect(await dump(out)).toBe(0)
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'))
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(datasets.map(dataset => `${dataset}.parquet`))
    const database = await DuckDBInstance.create(':memory:')
    try {
      const connection = await database.connect()
      for (const dataset of datasets) {
        const file = path.join(out, `${dataset}.parquet`)
        const result = await connection.runAndReadAll('SELECT SUM(clicks)::INTEGER AS clicks FROM read_parquet($1)', [file])
        expect(result.getRowObjects()).toEqual([{ clicks: 42 }])
      }
      connection.closeSync()
    }
    finally {
      database.closeSync()
    }
  })

  it('discards the staged export if one download is truncated', async () => {
    mockApi('bing_traffic')
    const out = path.join(directory, 'failed-export')
    expect(await dump(out)).toBe(1)
    expect(await fs.readdir(out)).toEqual([])
  })
})
