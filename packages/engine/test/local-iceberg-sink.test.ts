/**
 * Integration test for `LocalIcebergSink` against the POC local Iceberg stack
 * (`poc/iceberg/docker-compose.iceberg.yml` — Apache Iceberg REST catalog +
 * MinIO). Writes GSC fact rows through the sink, reads them back through
 * DuckDB's `iceberg` extension, and verifies the round-trip.
 *
 * This is the same format + query path production uses (`IcebergAppendSink`
 * → Iceberg → DuckDB/R2 SQL), so a green run here proves schema, partitioning, and
 * append-only ingest end to end. Ingest is 100% append-only (design v5):
 * exactly-once is the D1 ingested-days ledger's job, not the sink's.
 *
 * Requires:
 * - the docker stack up (`docker compose -f docker-compose.iceberg.yml up -d`)
 * - a Python env with `pyiceberg`, `pyarrow`, `duckdb`
 *
 * The suite SKIPS (does not fail) when either is unreachable, so CI without
 * the stack stays green. Point `GSCDUMP_ICEBERG_PYTHON` at the POC venv.
 */

import type { Row } from '../src/storage'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalIcebergSink } from '../src/sinks/local-iceberg-sink'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')
const READ_SCRIPT = join(SCRIPTS, 'iceberg-read.py')

const CATALOG_URI = process.env.GSCDUMP_ICEBERG_CATALOG ?? 'http://localhost:8181'
const WAREHOUSE = process.env.GSCDUMP_ICEBERG_WAREHOUSE ?? 'gscdump-poc-warehouse'
const NAMESPACE = `sink_it_${Date.now().toString(36)}`

const S3 = {
  endpoint: process.env.GSCDUMP_ICEBERG_S3_ENDPOINT ?? 'localhost:9100',
  accessKeyId: 'poc',
  secretAccessKey: 'pocpocpoc',
  region: 'us-east-1',
}

/**
 * Resolve a Python that has the Iceberg deps. Prefer `GSCDUMP_ICEBERG_PYTHON`;
 * fall back to the POC venv if this repo sits next to `gscdump.com`.
 */
function resolvePython(): string {
  if (process.env.GSCDUMP_ICEBERG_PYTHON)
    return process.env.GSCDUMP_ICEBERG_PYTHON
  const pocVenv = join(HERE, '..', '..', '..', '..', 'sites', 'gscdump.com', 'poc', 'iceberg', '.venv', 'bin', 'python')
  if (existsSync(pocVenv))
    return pocVenv
  return 'python3'
}

const PYTHON = resolvePython()

/** Probe: can we reach the catalog AND run the Iceberg deps? */
async function stackAvailable(): Promise<boolean> {
  // catalog reachable?
  const reachable = await fetch(`${CATALOG_URI}/v1/config`, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok)
    .catch(() => false)
  if (!reachable)
    return false
  // python deps importable?
  return new Promise<boolean>((resolve) => {
    execFile(PYTHON, ['-c', 'import pyiceberg, pyarrow, duckdb'], err => resolve(!err))
  })
}

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

const sink = createLocalIcebergSink({ catalogUri: CATALOG_URI, namespace: NAMESPACE, warehouse: WAREHOUSE, s3: S3, python: PYTHON })

function ctx(siteId: string) {
  return { userId: 'u1', siteId }
}

function pageRow(url: string, date: string, clicks: number): Row {
  return { url, date, clicks, impressions: clicks * 10, sum_position: clicks * 5 }
}

let available = false

describe('localIcebergSink — real local Iceberg round-trip', () => {
  beforeAll(async () => {
    available = await stackAvailable()
    if (!available) {
      console.warn(`[local-iceberg-sink] SKIPPED — POC Iceberg stack unreachable at ${CATALOG_URI} or python deps missing (${PYTHON})`)
    }
  }, 20_000)

  afterAll(async () => {
    await sink.close()
  })

  it('emits page rows into a real Iceberg table and reads them back via DuckDB', async () => {
    if (!available)
      return
    const res = await sink.emit(
      { ctx: ctx('site-a'), table: 'pages', searchType: 'web', date: '2026-04-01' },
      [pageRow('/', '2026-04-01', 10), pageRow('/about', '2026-04-01', 5)],
    )
    expect(res.rowCount).toBe(2)

    const rows = await runReader(`SELECT site_id, search_type, url, clicks FROM gsc.${NAMESPACE}.pages ORDER BY url`)
    expect(rows).toEqual([
      { site_id: 'site-a', search_type: 'web', url: '/', clicks: 10 },
      { site_id: 'site-a', search_type: 'web', url: '/about', clicks: 5 },
    ])
  }, 60_000)

  it('injects site_id + search_type partition columns from the slice', async () => {
    if (!available)
      return
    await sink.emit(
      { ctx: ctx('site-b'), table: 'queries', searchType: 'discover', date: '2026-04-02' },
      [{ query: 'nuxt seo', date: '2026-04-02', clicks: 8, impressions: 80, sum_position: 56 }],
    )
    const rows = await runReader(`SELECT site_id, search_type, query FROM gsc.${NAMESPACE}.keywords WHERE site_id = 'site-b'`)
    expect(rows).toEqual([{ site_id: 'site-b', search_type: 'discover', query: 'nuxt seo' }])
  }, 60_000)

  it('emit is append-only — re-emitting a slice accumulates rows (no overwrite)', async () => {
    if (!available)
      return
    const slice = { ctx: ctx('site-rev'), table: 'pages' as const, searchType: 'web' as const, date: '2026-05-01' }
    await sink.emit(slice, [pageRow('/', '2026-05-01', 10)])
    // a re-emit appends — there is no overwrite path. The D1 ingested-days
    // ledger prevents this in prod by emitting each slice exactly once.
    await sink.emit(slice, [pageRow('/', '2026-05-01', 10)])

    const rows = await runReader(`SELECT count(*) AS n, sum(clicks) AS clicks FROM gsc.${NAMESPACE}.pages WHERE site_id = 'site-rev'`)
    expect(rows).toEqual([{ n: 2, clicks: 20 }])
  }, 60_000)

  it('emit of an empty slice is a no-op', async () => {
    if (!available)
      return
    const res = await sink.emit(
      { ctx: ctx('site-a'), table: 'pages', searchType: 'web', date: '2026-04-09' },
      [],
    )
    expect(res.rowCount).toBe(0)
  })
})
