import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { pgResolverAdapter } from '@gscdump/engine/resolver'
import { pages } from '@gscdump/engine/schema'
import { and, eq, sql, sum } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core/alias'
import { QueryBuilder } from 'drizzle-orm/pg-core/query-builders/query-builder'
import { afterAll, describe, expect, it } from 'vitest'

describe('published Drizzle interoperability', () => {
  const db = createNodeDuckDBHandle()
  afterAll(() => resetNodeDuckDB())

  it('executes an external query builder over Engine tables and SQL fragments', async () => {
    await db.query(`CREATE TABLE pages (url VARCHAR, date DATE, clicks INTEGER, impressions INTEGER, sum_position DOUBLE);
      INSERT INTO pages VALUES ('/a', '2026-04-01', 2, 10, 30), ('/a', '2026-04-02', 3, 20, 40), ('/b', '2026-04-01', 1, 5, 5)`)
    const query = new QueryBuilder()
      .select({ url: pages.url, clicks: sum(sql`${pages.clicks}::DOUBLE`).as('clicks'), impressions: pgResolverAdapter.metricSql('impressions', 'pages').as('impressions') })
      .from(pages)
      .where(and(eq(pages.url, '/a'), sql`${pgResolverAdapter.dateColRef('pages')} >= ${'2026-04-01'}`))
      .groupBy(pages.url)
      .toSQL()
    expect(query.params).toEqual(['/a', '2026-04-01'])
    expect(await db.query(query.sql, query.params)).toEqual([{ url: '/a', clicks: 5, impressions: 30 }])
  })

  it('compiles external aliases and bound values through the Engine adapter', () => {
    const previous = alias(pages, 'previous')
    const result = pgResolverAdapter.compile(sql`SELECT ${previous.url} FROM ${pages} AS ${sql.identifier('previous')} WHERE ${eq(previous.url, '/it\'s-bound')}`)
    expect(result).toEqual({
      sql: 'SELECT "previous"."url" FROM "pages" AS "previous" WHERE "previous"."url" = $1',
      params: ['/it\'s-bound'],
    })
  })
})
