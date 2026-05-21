/**
 * Real-API e2e for the full analytics pipeline:
 *
 *   GSC Search Analytics API
 *     -> runGscSyncSlice (paging loop)
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

    // Walk the verified sites until one returns rows for the window — a single
    // property can legitimately be empty over any given 3-day span.
    let siteUrl: string | undefined
    let fetched: GscApiRow[] = []
    let totalRows = 0
    for (const site of sites.slice(0, 6)) {
      const rows: GscApiRow[] = []
      const result = await runGscSyncSlice({
        client,
        siteUrl: site.siteUrl,
        table: 'pages',
        startDate,
        endDate,
        rowLimit: 1000,
        maxPages: 2,
        onBatch: async (batch) => { rows.push(...batch) },
      })
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

    if (!siteUrl) {
      console.warn(`[pipeline-real] no GSC page data in ${startDate}..${endDate} across sampled sites — pipeline ran, round-trip skipped`)
      return
    }

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

      // `pages` slice dimensions are [page, date]; group rows per day for writeDay.
      const byDate = new Map<string, Row[]>()
      for (const r of fetched) {
        const [page, date] = r.keys
        if (!byDate.has(date))
          byDate.set(date, [])
        byDate.get(date)!.push({
          url: page,
          date,
          clicks: r.clicks,
          impressions: r.impressions,
          sum_position: r.position * r.impressions,
        })
      }
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

      // Row count collapses to distinct pages over the range.
      const distinctPages = new Set(fetched.map(r => r.keys[0])).size
      expect(queried.rows.length).toBe(distinctPages)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
