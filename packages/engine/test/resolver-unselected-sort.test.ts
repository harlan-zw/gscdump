import type { BuilderState } from 'gscdump/query'
import { DuckDBInstance } from '@duckdb/node-api'
import { between, date } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { createR2SqlResolverAdapter, pgResolverAdapter, resolveToSQL } from '../src/resolver'

describe('aggregate reads with an unselected sort metric', () => {
  it('sorts canonical query groups within a date by their combined clicks', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const connection = await instance.connect()
    try {
      await connection.run(`CREATE TABLE queries(query VARCHAR, date VARCHAR, clicks INTEGER, impressions INTEGER, sum_position INTEGER, site_id INTEGER, search_type INTEGER);
        CREATE TABLE query_dim(query VARCHAR, query_canonical VARCHAR);
        INSERT INTO queries VALUES('a1','2026-09-01',3,10,20,17,0),('a2','2026-09-01',4,10,20,17,0),('b','2026-09-01',5,100,900,17,0);
        INSERT INTO query_dim VALUES('a1','a'),('a2','a'),('b','b');`)
      const compiled = resolveToSQL({
        dimensions: ['date', 'queryCanonical'],
        metrics: ['impressions'],
        filter: between(date, '2026-09-01', '2026-09-02'),
        orderBy: { column: 'clicks', dir: 'desc' },
      }, { adapter: createR2SqlResolverAdapter(), siteId: 17, searchType: 0 })
      const params = compiled.params.map(value => typeof value === 'number' ? value : String(value))
      expect((await connection.runAndReadAll(compiled.sql, params)).getRowObjectsJS()).toEqual([
        { date: '2026-09-01', queryCanonical: 'a', impressions: 20 },
        { date: '2026-09-01', queryCanonical: 'b', impressions: 100 },
      ])
    }
    finally {
      connection.closeSync()
      instance.closeSync()
    }
  })

  it.each([
    { orderBy: undefined, expected: ['/a', '/b'] },
    { orderBy: { column: 'clicks', dir: 'asc' }, expected: ['/b', '/a'] },
    { orderBy: { column: 'impressions', dir: 'desc' }, expected: ['/b', '/a'] },
    { orderBy: { column: 'ctr', dir: 'desc' }, expected: ['/a', '/b'] },
    { orderBy: { column: 'position', dir: 'asc' }, expected: ['/a', '/b'] },
  ] as const)('sorts by $orderBy without adding fields to rows', async ({ orderBy, expected }) => {
    const instance = await DuckDBInstance.create(':memory:')
    const connection = await instance.connect()
    try {
      await connection.run(`CREATE TABLE pages(url VARCHAR, date VARCHAR, clicks INTEGER, impressions INTEGER, sum_position INTEGER);
        INSERT INTO pages VALUES('/a','2026-09-01',3,10,20),('/a','2026-09-02',4,10,20),('/b','2026-09-01',5,100,900);`)
      const state: BuilderState = {
        dimensions: ['page'],
        metrics: orderBy?.column === 'impressions' ? ['clicks'] : ['impressions'],
        filter: between(date, '2026-09-01', '2026-09-02'),
        orderBy,
        rowLimit: 10,
      }
      const compiled = resolveToSQL(state, { adapter: pgResolverAdapter })
      const rows = (await connection.runAndReadAll(compiled.sql, compiled.params.map(String))).getRowObjectsJS()
      expect(rows).toEqual(expected.map(page => state.metrics?.[0] === 'clicks'
        ? { page, clicks: page === '/a' ? 7 : 5 }
        : { page, impressions: page === '/a' ? 20 : 100 }))
    }
    finally {
      connection.closeSync()
      instance.closeSync()
    }
  })
})
