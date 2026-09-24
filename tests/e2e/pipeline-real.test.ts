/**
 * Real-API e2e for the full analytics pipeline:
 *
 *   GSC Search Analytics API
 *     -> runGscSyncSlice (paging loop)
 *     -> createRowAccumulator (the sync ingest path: rows per stored key)
 *     -> engine.writeDay (parquet encode + manifest register)
 *     -> engine.query   (DuckDB over the written parquet)
 *
 * Hits the live Google API read-only using BYOK env vars, then ingests the
 * fetched rows through the real engine (filesystem data source + Node DuckDB)
 * and asserts the data round-trips: the totals queried back out of parquet
 * equal the totals fetched from GSC.
 *
 * Skips automatically when no BYOK is configured. Run via:
 *   GSC_CLIENT_ID=... GSC_CLIENT_SECRET=... GSC_REFRESH_TOKEN=... \
 *   pnpm test:e2e pipeline-real
 *
 * Or with a raw bearer:
 *   GSC_ACCESS_TOKEN=ya29... pnpm test:e2e pipeline-real
 */

import type { Row } from '@gscdump/engine'
import type { GscApiRow } from '@gscdump/engine-gsc-api'
import type { BuilderState } from 'gscdump/query'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createDuckDBCodec, createDuckDBExecutor, createStorageEngine } from '@gscdump/engine'
import { runGscSyncSlice } from '@gscdump/engine-gsc-api'
import { createFilesystemDataSource, createFilesystemManifestStore } from '@gscdump/engine/filesystem'
import { createRowAccumulator, toPath } from '@gscdump/engine/ingest'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { createAuth, googleSearchConsole } from 'gscdump'
import { afterAll, describe, expect, it } from 'vitest'

function resolveAuth() {
  const accessToken = process.env.GSC_ACCESS_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN
  const clientId = process.env.GSC_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GSC_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GSC_REFRESH_TOKEN ?? process.env.GOOGLE_REFRESH_TOKEN
  if (clientId && clientSecret && refreshToken)
    return createAuth({ clientId, clientSecret, refreshToken })
  if (accessToken)
    return accessToken
  return null
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object')
    return undefined
  const err = error as {
    response?: { status?: number }
    status?: number
    statusCode?: number
  }
  return err.response?.status ?? err.status ?? err.statusCode
}

const auth = resolveAuth()
const skip = !auth

describe.skipIf(skip)('analytics pipeline — real API → parquet → query', () => {
  const client = googleSearchConsole(auth!)
  // Finalized window: 7 days back, 3-day span — past GSC's 2-3 day data lag.
  const endDate = isoDaysAgo(7)
  const startDate = isoDaysAgo(9)

  afterAll(() => {
    resetNodeDuckDB()
  })

  it('round-trips real GSC page data through engine parquet and back', async () => {
    const sites = await client.sites()
    expect(sites.length).toBeGreaterThan(0)

    // Walk the verified sites until one returns rows for the window. A single
    // property can legitimately be empty, and some verified properties can
    // deny Search Analytics for this token even though they appear in sites().
    let siteUrl: string | undefined
    let fetched: GscApiRow[] = []
    let totalRows = 0
    let denied = 0
    const selectedSite = process.env.GSC_SITE_URL
    const candidates = selectedSite ? sites.filter(site => site.siteUrl === selectedSite) : sites.slice(0, 12)
    expect(candidates.length, 'GSC_SITE_URL must identify an accessible Site.').toBeGreaterThan(0)
    for (const site of candidates) {
      const rows: GscApiRow[] = []
      let result: Awaited<ReturnType<typeof runGscSyncSlice>>
      try {
        result = await runGscSyncSlice({
          client,
          siteUrl: site.siteUrl,
          table: 'pages',
          startDate,
          endDate,
          rowLimit: 1000,
          maxPages: 2,
          onBatch: async (batch) => { rows.push(...batch) },
        })
      }
      catch (error) {
        if (errorStatus(error) === 403) {
          denied++
          console.warn(`[pipeline-real] skipping ${site.siteUrl}: Search Analytics returned 403`)
          continue
        }
        throw error
      }
      // The slice must always terminate cleanly against the real API.
      expect(typeof result.hasMore).toBe('boolean')
      expect(result.totalRows).toBe(rows.length)
      if (rows.length > 0) {
        siteUrl = site.siteUrl
        fetched = rows
        totalRows = result.totalRows
        break
      }
    }

    if (!siteUrl)
      throw new Error(`No GSC page rows in ${startDate}..${endDate}; ${denied} Sites denied access. Set GSC_SITE_URL to a Site with traffic.`)

    expect(fetched.length).toBe(totalRows)
    const fetchedClicks = fetched.reduce((s, r) => s + r.clicks, 0)
    const fetchedImpressions = fetched.reduce((s, r) => s + r.impressions, 0)

    // --- Ingest the fetched rows through the real engine -------------------
    const dir = await mkdtemp(join(tmpdir(), 'gscdump-pipeline-e2e-'))
    try {
      const factory = { getDuckDB: async () => createNodeDuckDBHandle() }
      const engine = createStorageEngine({
        dataSource: createFilesystemDataSource({ rootDir: dir }),
        manifestStore: createFilesystemManifestStore({ path: join(dir, 'manifest.json') }),
        codec: createDuckDBCodec(factory),
        executor: createDuckDBExecutor(factory),
      })

      // Ingest the way sync does: the accumulator maps Google URLs to stored
      // paths and groups rows per day for writeDay.
      const accumulator = createRowAccumulator()
      expect(accumulator.push('pages', fetched)).toBe(true)
      const byDate = accumulator.drain().get('pages') ?? new Map<string, Row[]>()
      for (const [date, rows] of byDate) {
        await engine.writeDay({ userId: 'e2e', siteId: 'e2e-site', table: 'pages', date }, rows)
      }

      // --- Query it back out of parquet -----------------------------------
      const state: BuilderState = {
        dimensions: ['page'],
        filter: {
          _filters: [{ dimension: 'date', operator: 'between', expression: startDate, expression2: endDate }],
        } as unknown as BuilderState['filter'],
      }
      const queried = await engine.query({ userId: 'e2e', siteId: 'e2e-site' }, state)

      // Parquet objects were written and are all web-typed (default searchType).
      expect(queried.objectKeys.length).toBeGreaterThan(0)
      for (const key of queried.objectKeys)
        expect(key).not.toContain('/discover/')

      // Clicks + impressions are exact sums — they must survive the round-trip.
      const queriedClicks = queried.rows.reduce((s, r) => s + Number(r.clicks), 0)
      const queriedImpressions = queried.rows.reduce((s, r) => s + Number(r.impressions), 0)
      expect(queriedClicks).toBe(fetchedClicks)
      expect(queriedImpressions).toBe(fetchedImpressions)

      // Row count collapses to distinct stored paths over the range. Google
      // URLs that differ only by Site prefix share one path.
      const distinctPages = new Set(fetched.map(r => toPath(r.keys[0]!))).size
      expect(queried.rows.length).toBe(distinctPages)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
