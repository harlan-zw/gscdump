/**
 * Integration test for the trailing-window Iceberg overwrite writer (P1.4) —
 * the GSC-revision path. Runs against the POC local Iceberg stack
 * (`poc/iceberg/docker-compose.iceberg.yml` — Apache Iceberg REST catalog +
 * MinIO).
 *
 * The writer is the production `SliceOverwriteWriter` that `PipelineSink`
 * delegates `overwriteSlice` to (Pipelines is append-only). It runs PyIceberg
 * `table.overwrite(df, overwrite_filter=…)` — the spike-proven partition
 * overwrite — through a backend transport. This suite exercises the
 * `subprocessBackend` (the local-test / Node-job-box transport); the prod
 * `httpBackend` is the same job shape over HTTP to a Cloudflare Container.
 *
 * What it proves:
 * - a slice can be written then partition-overwritten with revised values;
 * - reads return ONLY the revised rows — no duplicates, no stale rows;
 * - overwrite scopes to the exact `(site, searchType, date)` partition;
 * - a daily re-sync of the trailing window converges restated GSC metrics;
 * - `PipelineSink.overwriteSlice` routes through the writer correctly.
 *
 * Requires the docker stack up + a Python env with `pyiceberg`/`pyarrow`/
 * `duckdb`. SKIPS (does not fail) when either is unreachable. Point
 * `GSCDUMP_ICEBERG_PYTHON` at the POC venv.
 */

import type { Row } from '../src/storage'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIcebergOverwriteWriter, subprocessBackend } from '../src/iceberg/overwrite-writer'
import { createPipelineSink } from '../src/sinks/pipeline-sink'

const HERE = dirname(fileURLToPath(import.meta.url))
const READ_SCRIPT = join(HERE, '..', 'scripts', 'iceberg-read.py')
const WRITE_SCRIPT = join(HERE, '..', 'scripts', 'iceberg-writer.py')

const CATALOG_URI = process.env.GSCDUMP_ICEBERG_CATALOG ?? 'http://localhost:8181'
const WAREHOUSE = process.env.GSCDUMP_ICEBERG_WAREHOUSE ?? 'gscdump-poc-warehouse'
const NAMESPACE = `ow_it_${Date.now().toString(36)}`

const S3 = {
  endpoint: process.env.GSCDUMP_ICEBERG_S3_ENDPOINT ?? 'localhost:9100',
  accessKeyId: 'poc',
  secretAccessKey: 'pocpocpoc',
  region: 'us-east-1',
}

function resolvePython(): string {
  if (process.env.GSCDUMP_ICEBERG_PYTHON)
    return process.env.GSCDUMP_ICEBERG_PYTHON
  const pocVenv = join(HERE, '..', '..', '..', '..', 'sites', 'gscdump.com', 'poc', 'iceberg', '.venv', 'bin', 'python')
  if (existsSync(pocVenv))
    return pocVenv
  return 'python3'
}

const PYTHON = resolvePython()

async function stackAvailable(): Promise<boolean> {
  const reachable = await fetch(`${CATALOG_URI}/v1/config`, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok)
    .catch(() => false)
  if (!reachable)
    return false
  return new Promise<boolean>((resolve) => {
    execFile(PYTHON, ['-c', 'import pyiceberg, pyarrow, duckdb'], err => resolve(!err))
  })
}

/** Read rows back through DuckDB's iceberg extension (server-tail proxy). */
function runReader(sql: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const child = execFile(PYTHON, [READ_SCRIPT], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout.trim()) {
        const parsed = JSON.parse(stdout) as { rows?: Row[], error?: string }
        if (parsed.error) {
          reject(new Error(`reader: ${parsed.error}`))
          return
        }
        resolve(parsed.rows ?? [])
        return
      }
      reject(new Error(`reader produced no output: ${err?.message ?? ''} ${stderr}`))
    })
    child.stdin?.end(JSON.stringify({ catalogUri: CATALOG_URI, namespace: NAMESPACE, warehouse: WAREHOUSE, s3: S3, sql }))
  })
}

const catalog = { catalogUri: CATALOG_URI, namespace: NAMESPACE, warehouse: WAREHOUSE, s3: S3 }
const backend = subprocessBackend({ python: PYTHON, writerScript: WRITE_SCRIPT })
const writer = createIcebergOverwriteWriter({ catalog, backend })

function ctx(siteId: string) {
  return { userId: 'u1', siteId }
}

/** Page fact row — data columns only (writer injects site_id/search_type). */
function pageRow(url: string, date: string, clicks: number): Row {
  return { url, date, clicks, impressions: clicks * 10, sum_position: clicks * 5 }
}

let available = false

describe('icebergOverwriteWriter — trailing-window partition overwrite (P1.4)', () => {
  beforeAll(async () => {
    available = await stackAvailable()
    if (!available)
      console.warn(`[iceberg-overwrite-writer] SKIPPED — POC Iceberg stack unreachable at ${CATALOG_URI} or python deps missing (${PYTHON})`)
  }, 20_000)

  afterAll(async () => {
    await writer.close()
  })

  it('writes a slice, then overwrites it with revised values — reads return only revised data', async () => {
    if (!available)
      return
    const slice = { ctx: ctx('site-rev'), table: 'pages' as const, searchType: 'web' as const, date: '2026-05-01' }

    // initial sync — two rows, 15 total clicks
    const first = await writer.overwriteSlice(slice, [
      pageRow('/', '2026-05-01', 10),
      pageRow('/about', '2026-05-01', 5),
    ])
    expect(first.rowCount).toBe(2)

    // GSC restates the day; daily re-sync overwrites with revised values
    const revised = await writer.overwriteSlice(slice, [pageRow('/', '2026-05-01', 40)])
    expect(revised.rowCount).toBe(1)

    const rows = await runReader(`SELECT url, clicks FROM gsc.${NAMESPACE}.pages WHERE site_id = 'site-rev' ORDER BY url`)
    // partition fully replaced — no double-count, no stale /about row
    expect(rows).toEqual([{ url: '/', clicks: 40 }])
  }, 60_000)

  it('scopes the overwrite to the exact (site, searchType, date) partition', async () => {
    if (!available)
      return
    const day1 = { ctx: ctx('site-scope'), table: 'pages' as const, searchType: 'web' as const, date: '2026-06-01' }
    const day2 = { ctx: ctx('site-scope'), table: 'pages' as const, searchType: 'web' as const, date: '2026-06-02' }
    const otherType = { ctx: ctx('site-scope'), table: 'pages' as const, searchType: 'discover' as const, date: '2026-06-01' }

    await writer.overwriteSlice(day1, [pageRow('/', '2026-06-01', 11)])
    await writer.overwriteSlice(day2, [pageRow('/', '2026-06-02', 22)])
    await writer.overwriteSlice(otherType, [pageRow('/', '2026-06-01', 33)])

    // overwrite only day1/web
    await writer.overwriteSlice(day1, [pageRow('/', '2026-06-01', 111)])

    const web = await runReader(`SELECT date, clicks FROM gsc.${NAMESPACE}.pages WHERE site_id = 'site-scope' AND search_type = 'web' ORDER BY date`)
    expect(web).toEqual([
      { date: '2026-06-01', clicks: 111 },
      { date: '2026-06-02', clicks: 22 },
    ])
    // the discover partition for the same date is untouched
    const disc = await runReader(`SELECT date, clicks FROM gsc.${NAMESPACE}.pages WHERE site_id = 'site-scope' AND search_type = 'discover'`)
    expect(disc).toEqual([{ date: '2026-06-01', clicks: 33 }])
  }, 60_000)

  it('converges a daily re-sync of the trailing 3-day window with no duplicates', async () => {
    if (!available)
      return
    const site = 'site-trailing'
    const days = ['2026-07-10', '2026-07-11', '2026-07-12']
    const sliceFor = (date: string) => ({ ctx: ctx(site), table: 'keywords' as const, searchType: 'web' as const, date })
    const kw = (query: string, date: string, clicks: number): Row =>
      ({ query, date, clicks, impressions: clicks * 10, sum_position: clicks })

    // day-N sync writes each day once
    for (const d of days)
      await writer.overwriteSlice(sliceFor(d), [kw('seo', d, 100), kw('nuxt', d, 50)])

    // GSC restates the trailing window; the next daily sync re-overwrites it
    for (const d of days)
      await writer.overwriteSlice(sliceFor(d), [kw('seo', d, 250), kw('nuxt', d, 60)])

    const rows = await runReader(
      `SELECT date, SUM(clicks) AS clicks, COUNT(*) AS n, COUNT(DISTINCT query) AS dq `
      + `FROM gsc.${NAMESPACE}.keywords WHERE site_id = '${site}' GROUP BY date ORDER BY date`,
    )
    // every day shows revised totals, exactly 2 rows, no duplicate query rows
    expect(rows).toEqual(days.map(date => ({ date, clicks: 310, n: 2, dq: 2 })))
  }, 90_000)

  it('overwriting with an empty slice clears the partition', async () => {
    if (!available)
      return
    const slice = { ctx: ctx('site-empty'), table: 'pages' as const, searchType: 'web' as const, date: '2026-08-01' }
    await writer.overwriteSlice(slice, [pageRow('/', '2026-08-01', 9)])
    const cleared = await writer.overwriteSlice(slice, [])
    expect(cleared.rowCount).toBe(0)

    const rows = await runReader(`SELECT url FROM gsc.${NAMESPACE}.pages WHERE site_id = 'site-empty'`)
    expect(rows).toEqual([])
  }, 60_000)

  it('pipelineSink.overwriteSlice routes through the writer (append-only delegation)', async () => {
    if (!available)
      return
    // a fake append-only Pipeline Stream — emit goes here, overwrite must NOT
    const streamed: unknown[] = []
    const sink = createPipelineSink({
      stream: { send: async (records: readonly unknown[]) => { streamed.push(...records) } },
      overwriteWriter: writer,
    })
    expect(sink.capabilities).toEqual({ canOverwrite: false, appendOnly: true })

    const slice = { ctx: ctx('site-pipe'), table: 'pages' as const, searchType: 'web' as const, date: '2026-09-01' }
    // revision path: PipelineSink delegates to the Iceberg overwrite writer
    const res = await sink.overwriteSlice(slice, [pageRow('/', '2026-09-01', 77)])
    expect(res.rowCount).toBe(1)
    expect(streamed).toHaveLength(0) // overwrite never touches the stream

    const rows = await runReader(`SELECT url, clicks FROM gsc.${NAMESPACE}.pages WHERE site_id = 'site-pipe'`)
    expect(rows).toEqual([{ url: '/', clicks: 77 }])

    await sink.close()
  }, 60_000)

  it('surfaces a backend failure as a thrown error', async () => {
    if (!available)
      return
    const slice = { ctx: ctx('site-bad'), table: 'pages' as const, searchType: 'web' as const, date: '2026-10-01' }
    // null in a required metric column — PyIceberg rejects the cast
    await expect(
      writer.overwriteSlice(slice, [{ url: '/', date: '2026-10-01', clicks: null, impressions: 1, sum_position: 1 }]),
    ).rejects.toThrow(/PyIceberg backend failed/)
  }, 60_000)

  it('requires slice.ctx.siteId for the partition key', async () => {
    await expect(
      writer.overwriteSlice(
        { ctx: { userId: 'u1' }, table: 'pages', searchType: 'web', date: '2026-11-01' },
        [pageRow('/', '2026-11-01', 1)],
      ),
    ).rejects.toThrow(/siteId is required/)
  })
})
