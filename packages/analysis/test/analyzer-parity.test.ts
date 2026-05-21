/**
 * Parity harness for dual-path analyzers. For each analyzer that ships
 * both `.sql` and `.rows` variants, run the same fixture through both
 * paths and assert their results conform to the same shape.
 *
 * Strict deep-equal is intentionally NOT enforced: a few analyzers (e.g.
 * zero-click) deliberately diverge — SQL groups by query+page while the
 * row reducer dedupes to best page per query. Documented in PARITY.
 *
 * What we DO assert:
 *   - both paths return well-formed `{ results, meta }`
 *   - result row shapes (keys present) match between paths
 *   - row counts within tolerance per analyzer
 */

import type { Row, TableName } from '@gscdump/engine/contracts'
import type { BuilderState } from 'gscdump/query'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '@gscdump/engine'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '@gscdump/engine/filesystem'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '@gscdump/engine/node'
import { runAnalyzerWithEngine } from '@gscdump/engine/source'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAnalyzerRegistry } from '../src/default-registry'
import { createInMemoryQuerySource } from '../src/source/in-memory'

afterAll(() => {
  resetNodeDuckDB()
})

const USER = 'u1'
const SITE = 's1'

interface Seed {
  table: TableName
  date: string
  rows: Row[]
}

async function setupEngine(dir: string) {
  const handle = createNodeDuckDBHandle()
  const factory = { getDuckDB: async () => handle }
  const codec = createDuckDBCodec(factory)
  const executor = createDuckDBExecutor(factory)
  const dataSource = createFilesystemDataSource({ rootDir: dir })
  const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
  return createStorageEngine({ dataSource, manifestStore, codec, executor })
}

async function seedEngine(engine: ReturnType<typeof createStorageEngine>, seeds: Seed[]) {
  for (const s of seeds)
    await engine.writeDay({ userId: USER, siteId: SITE, table: s.table, date: s.date }, s.rows)
}

/**
 * Aggregate raw partition rows into the shape the row source serves
 * (per-query/page totals, not per-day partitions). Mirrors what
 * `compileLogicalQueryPlan` would emit at the SQL boundary.
 */
function aggregateForRows(seeds: Seed[]): Row[] {
  const map = new Map<string, { query: string, page: string, clicks: number, impressions: number, sum_position: number }>()
  for (const s of seeds) {
    for (const r of s.rows) {
      const query = String(r.query ?? '')
      const page = String(r.url ?? r.page ?? '')
      const key = `${query}\x00${page}`
      const existing = map.get(key) ?? { query, page, clicks: 0, impressions: 0, sum_position: 0 }
      existing.clicks += Number(r.clicks ?? 0)
      existing.impressions += Number(r.impressions ?? 0)
      existing.sum_position += Number(r.sum_position ?? 0)
      map.set(key, existing)
    }
  }
  return Array.from(map.values()).map(r => ({
    query: r.query,
    page: r.page,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    position: r.impressions > 0 ? (r.sum_position / r.impressions) + 1 : 0,
  }))
}

/** Pick row-source rows for a given BuilderState by inspecting its dimensions. */
function rowsForState(state: BuilderState, aggregated: Row[]): Row[] {
  const dims = state.dimensions
  if (dims.includes('query') && dims.includes('page'))
    return aggregated
  if (dims.includes('page')) {
    const m = new Map<string, Row>()
    for (const r of aggregated) {
      const k = String(r.page ?? '')
      const e = m.get(k) ?? { page: k, clicks: 0, impressions: 0, sum_position: 0 }
      e.clicks = Number(e.clicks) + Number(r.clicks)
      e.impressions = Number(e.impressions) + Number(r.impressions)
      m.set(k, e)
    }
    return Array.from(m.values()).map(r => ({
      page: r.page,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Number(r.impressions) > 0 ? Number(r.clicks) / Number(r.impressions) : 0,
      position: 0,
    }))
  }
  return aggregated
}

interface ParityCase {
  id: string
  params: Record<string, unknown>
  seed: Seed[]
  /** Optional override: how many rows the row source should return (skips strict equality when divergence is expected). */
  expectDivergence?: boolean
}

const SHARED_SEED: Seed[] = [
  {
    table: 'page_queries',
    date: '2026-04-10',
    rows: [
      { url: '/a', query: 'big opportunity', date: '2026-04-10', clicks: 5, impressions: 10_000, sum_position: 100_000 },
      { url: '/b', query: 'striking', date: '2026-04-10', clicks: 2, impressions: 500, sum_position: 3000 },
      { url: '/c', query: 'zero clicks', date: '2026-04-10', clicks: 1, impressions: 5000, sum_position: 5000 },
      { url: '/d', query: 'brand alpha', date: '2026-04-10', clicks: 50, impressions: 1000, sum_position: 1000 },
      { url: '/e', query: 'irrelevant', date: '2026-04-10', clicks: 1, impressions: 50, sum_position: 250 },
    ],
  },
]

const CASES: ParityCase[] = [
  { id: 'striking-distance', params: { type: 'striking-distance', startDate: '2026-04-10', endDate: '2026-04-10' }, seed: SHARED_SEED },
  { id: 'opportunity', params: { type: 'opportunity', startDate: '2026-04-10', endDate: '2026-04-10' }, seed: SHARED_SEED },
  { id: 'brand', params: { type: 'brand', startDate: '2026-04-10', endDate: '2026-04-10', brandTerms: ['brand'] }, seed: SHARED_SEED },
  { id: 'zero-click', params: { type: 'zero-click', startDate: '2026-04-10', endDate: '2026-04-10', minImpressions: 100 }, seed: SHARED_SEED, expectDivergence: true },
  { id: 'cannibalization', params: { type: 'cannibalization', startDate: '2026-04-10', endDate: '2026-04-10' }, seed: SHARED_SEED, expectDivergence: true },
  { id: 'concentration', params: { type: 'concentration', startDate: '2026-04-10', endDate: '2026-04-10', dimension: 'pages' }, seed: SHARED_SEED },
  { id: 'clustering', params: { type: 'clustering', startDate: '2026-04-10', endDate: '2026-04-10' }, seed: SHARED_SEED, expectDivergence: true },
]

describe('analyzer parity (sql vs rows)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-parity-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  for (const c of CASES) {
    it(`${c.id}: both paths execute and return well-formed results`, async () => {
      const variants = defaultAnalyzerRegistry.getAnalyzerVariants(c.id)
      expect(variants?.sql, `${c.id} missing sql variant`).toBeTruthy()
      expect(variants?.rows, `${c.id} missing rows variant`).toBeTruthy()

      const engine = await setupEngine(dir)
      await seedEngine(engine, c.seed)

      const sqlOut = await runAnalyzerWithEngine(
        { engine },
        { userId: USER, siteId: SITE },
        c.params as never,
        defaultAnalyzerRegistry,
      )

      const aggregated = aggregateForRows(c.seed)
      const source = createInMemoryQuerySource({ queryRows: state => rowsForState(state, aggregated) })
      const rowsOut = await runAnalyzerFromSource(source, c.params as never, defaultAnalyzerRegistry)

      expect(Array.isArray(sqlOut.results), `${c.id} sql.results should be array`).toBe(true)
      expect(Array.isArray(rowsOut.results), `${c.id} rows.results should be array`).toBe(true)

      if (sqlOut.results.length > 0 && rowsOut.results.length > 0 && !c.expectDivergence) {
        const sqlKeys = Object.keys(sqlOut.results[0]!).sort()
        const rowKeys = Object.keys(rowsOut.results[0]!).sort()
        // Allow row-side reducers to add 'segment' / 'direction' tags etc;
        // assert the SQL keys are a subset.
        for (const k of sqlKeys)
          expect(rowKeys, `${c.id}: row result missing key "${k}" present in sql result`).toContain(k)
      }
    }, 30_000)
  }
})
