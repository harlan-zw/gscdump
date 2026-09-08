import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createDuckDBCodec, createDuckDBExecutor } from '@gscdump/engine'
import { createFilesystemDataSource } from '@gscdump/engine/filesystem'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir: string
let sequence = 0
const db = createNodeDuckDBHandle()
const factory = { getDuckDB: async () => db }
const codec = createDuckDBCodec(factory)
const executor = createDuckDBExecutor(factory)
const analyzer = defaultAnalyzerRegistry.getAnalyzerVariants('bipartite-pagerank')!.sql!

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gscdump-pagerank-test-'))
})
afterAll(async () => {
  resetNodeDuckDB()
  await rm(dir, { recursive: true })
})

function edge(query: string, url: string, impressions: number, date = '2026-04-10'): Row {
  return { query, url, impressions, date, clicks: 1, sum_position: impressions * 3 }
}

async function run(rows: Row[], options: Partial<AnalysisParams> = {}) {
  const params: AnalysisParams = {
    type: 'bipartite-pagerank',
    startDate: '2026-04-01',
    endDate: '2026-04-30',
    ...options,
  }
  const dataSource = createFilesystemDataSource({ rootDir: dir })
  const key = `${sequence++}.parquet`
  await codec.writeRows({ table: 'page_queries' }, rows, key, dataSource)
  const plan = analyzer.build(params)
  if (plan.kind !== 'sql')
    throw new Error('Expected a SQL Analyzer')
  const result = await executor.execute({
    sql: plan.sql,
    params: plan.params,
    fileKeys: { FILES: [key] },
    dataSource,
    table: 'page_queries',
  })
  return analyzer.reduce(result.rows, { params }) as {
    results: { kind: string, id: string, rank: number, degree: number, impressions: number, bridging: number, anchoring: number }[]
    meta: { queryCount: number, urlCount: number, convergenceDelta: number, deltas: { step: number, l1: number }[] }
  }
}

describe('bipartite-pagerank', () => {
  it('preserves the weighted star fixed point and every convergence step', async () => {
    const out = await run([edge('a', '/hub', 300), edge('b', '/hub', 100)])
    expect(out.results).toEqual([
      { kind: 'query', id: 'a', rank: expect.closeTo(0.7125, 12), degree: 1, impressions: 300, bridging: 1, anchoring: 0 },
      { kind: 'query', id: 'b', rank: expect.closeTo(0.2875, 12), degree: 1, impressions: 100, bridging: 1, anchoring: 0 },
      { kind: 'url', id: '/hub', rank: expect.closeTo(1, 12), degree: 2, impressions: 400, bridging: 0, anchoring: 2 },
    ])
    expect(out.meta.queryCount).toBe(2)
    expect(out.meta.urlCount).toBe(1)
    expect(out.meta.deltas).toHaveLength(25)
    expect(out.meta.deltas[0]!.l1).toBeCloseTo(0.425, 12)
    for (const delta of out.meta.deltas.slice(1))
      expect(delta.l1).toBeCloseTo(0, 12)
  })

  it('applies the result limit after ranking the whole graph', async () => {
    const out = await run([edge('a', '/hub', 300), edge('b', '/hub', 100)], { limit: 1 })
    expect(out.results.map(r => [r.id, r.rank])).toEqual([['a', expect.closeTo(0.7125, 12)], ['/hub', expect.closeTo(1, 12)]])
    expect(out.meta.queryCount).toBe(2)
  })

  it('preserves an empty result and metadata for a zero limit', async () => {
    const out = await run([edge('a', '/hub', 300)], { limit: 0 })
    expect(out.results).toEqual([])
    expect(out.meta).toMatchObject({ queryCount: 0, urlCount: 0, deltas: [] })
  })

  it('rejects a negative limit', async () => {
    await expect(run([edge('a', '/hub', 300)], { limit: -1 })).rejects.toThrow(/negative/i)
  })

  it('filters dates and empty identifiers before aggregating edge impressions', async () => {
    const out = await run([
      edge('a', '/hub', 30),
      edge('a', '/hub', 30),
      edge('b', '/hub', 40),
      edge('outside', '/hub', 10000, '2026-03-01'),
      edge('', '/hub', 10000),
      edge('a', '', 10000),
    ])
    expect(out.results.map(r => [r.id, r.rank, r.impressions])).toEqual([['a', 1, 60], ['/hub', 1, 60]])
  })

  it.each([{ rows: [] }, { rows: [edge('a', '/hub', 1)] }])('returns an empty graph without qualifying edges', async ({ rows }) => {
    const out = await run(rows)
    expect(out.results).toEqual([])
    expect(out.meta).toMatchObject({ queryCount: 0, urlCount: 0, convergenceDelta: 0, deltas: [] })
  })

  it('preserves SQL null ranks for a graph with zero impressions', async () => {
    const out = await run([edge('a', '/hub', 0)], { minImpressions: 0 })
    expect(out.results.map(r => [r.id, r.rank, r.bridging, r.anchoring])).toEqual([
      ['a', 0, 0, 0],
      ['/hub', 0, 0, 0],
    ])
    expect(out.meta.deltas).toEqual(Array.from({ length: 25 }, (_, i) => ({ step: i + 1, l1: 0 })))
  })

  it('caps each side by impressions before ranking the remaining graph', async () => {
    const rows = [
      ...Array.from({ length: 1001 }, (_, i) => edge(`q${i}`, '/hub', i + 100)),
      ...Array.from({ length: 501 }, (_, i) => edge('q1000', `/p${i}`, i + 100)),
    ]
    const out = await run(rows, { limit: 2000 })
    expect(out.meta.queryCount).toBe(1000)
    expect(out.meta.urlCount).toBe(500)
    const ids = out.results.map(r => r.id)
    expect(ids).not.toContain('q0')
    expect(ids).not.toContain('/p0')
    expect(ids).not.toContain('/p1')
    expect(ids).toContain('q1')
    expect(ids).toContain('/p2')
    expect(out.results.find(r => r.id === 'q1000')!.rank).toBeGreaterThan(out.results.find(r => r.id === 'q1')!.rank)
  })
})
