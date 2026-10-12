import type { TopNBreakdownQuery } from '@gscdump/contracts/archetypes'
import type { BuilderState } from 'gscdump/query'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { formatLiteral } from '@gscdump/engine/sql'
import { between, date } from 'gscdump/query'
import { afterAll, beforeAll, expect } from 'vitest'

export const db = createNodeDuckDBHandle()
export const parquetPath = db.makeTempPath('parquet')
export const currentRange = { start: '2026-03-01', end: '2026-03-31' }
export const previousRange = { start: '2026-02-01', end: '2026-02-28' }
const expected = Array.from({ length: 240 }, (_, i) => `term-${String(i).padStart(3, '0')}`)

export function pagingState(limit: number, range = currentRange): BuilderState {
  return {
    dimensions: ['query'],
    metrics: ['clicks', 'impressions', 'ctr', 'position'],
    filter: between(date, range.start, range.end),
    orderBy: { column: 'clicks', dir: 'desc' },
    rowLimit: limit,
  }
}

export function pagingArchetype(limit: number, comparison: boolean): TopNBreakdownQuery {
  return {
    archetype: 'top-n-breakdown',
    siteId: 'site-1',
    searchType: 'web',
    range: currentRange,
    ...(comparison ? { compareRange: previousRange } : {}),
    dimension: 'query',
    metrics: ['clicks', 'impressions', 'ctr', 'position'],
    orderBy: { metric: 'clicks', dir: 'desc' },
    limit,
  }
}

beforeAll(async () => {
  await db.query('CREATE TABLE queries (date DATE, query VARCHAR, clicks INTEGER, impressions INTEGER, sum_position DOUBLE)')
  // Every metric ties. Storage order must not decide which page contains a row.
  const values = [...expected].reverse().flatMap(key => [
    `('2026-03-05', '${key}', 0, 10, 20)`,
    `('2026-02-05', '${key}', 0, 10, 20)`,
  ])
  await db.query(`INSERT INTO queries VALUES ${values.join(', ')}`)
  await db.query('INSERT INTO queries VALUES (\'2026-03-05\', \'z-current\', 0, 10, 20), (\'2026-02-05\', \'z-previous\', 0, 10, 20)')
  await db.query(`COPY queries TO ${formatLiteral(parquetPath)} (FORMAT PARQUET)`)
  await db.query('CREATE TABLE page_queries AS SELECT q.*, suffix.url FROM queries q CROSS JOIN (VALUES (\'https://example.com/b\'), (\'https://example.com/a\')) suffix(url)')
})

afterAll(resetNodeDuckDB)

export async function verifyPaging(compile: (limit: number) => { sql: string, params: unknown[] }, comparison = false): Promise<void> {
  const exported: string[] = []
  for (const end of [100, 200, 300]) {
    const plan = compile(end)
    const rows = await db.query(plan.sql, plan.params)
    exported.push(...rows.slice(end - 100, end).map(row => String(row.query)))
  }
  const keys = [...expected, 'z-current', ...(comparison ? ['z-previous'] : [])]
  expect(exported).toEqual(keys)
  expect(new Set(exported).size).toBe(keys.length)
}

export async function verifyCompositePaging(compile: (limit: number) => { sql: string, params: unknown[] }): Promise<void> {
  const exported: string[] = []
  for (const end of [100, 200, 300, 400, 500]) {
    const plan = compile(end)
    const rows = await db.query(plan.sql, plan.params)
    exported.push(...rows.slice(end - 100, end).map(row => `${row.query}|${row.page}`))
  }
  const keys = [...expected, 'z-current'].flatMap(key => [
    `${key}|/a`,
    `${key}|/b`,
  ])
  expect(exported).toEqual(keys)
  expect(new Set(exported).size).toBe(keys.length)
}
