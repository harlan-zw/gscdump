/**
 * Browser primitives: drizzle schema load, SQL compilation, and window
 * resolution. Runs in Node with a stub client that records the SQL it sees
 * instead of executing against DuckDB-WASM (which needs a browser env).
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

import { pgResolverAdapter, resolveToSQL } from '@gscdump/engine/resolver'
import { desc, eq, sum } from 'drizzle-orm'
import { and, between, contains, date, gsc, or, page, query, regex } from 'gscdump/query'

import { describe, expect, it } from 'vitest'
import {
  createInsightRunner,
  page_queries,
  queries,
  resolveWindow,
  scopeFor,
} from '../src'
import { createClient } from '../src/drizzle-adapter/client'

interface Captured {
  sql: string
  params: unknown[]
}

function stubConn(captured: Captured[]): AsyncDuckDBConnection {
  return {
    async query(sql: string) {
      captured.push({ sql, params: [] })
      return {
        toArray: () => [],
      } as any
    },
    async prepare(sql: string) {
      return {
        async query(...params: unknown[]) {
          captured.push({ sql, params })
          return { toArray: () => [] } as any
        },
        close() {},
      } as any
    },
    async close() {},
  } as unknown as AsyncDuckDBConnection
}

function stubDb(): AsyncDuckDB {
  return {} as AsyncDuckDB
}

describe('@gscdump/engine-duckdb-wasm', () => {
  it('schema asserts in-sync with SCHEMAS at module load', async () => {
    // Bare import triggers assertInSync(). No throw = pass.
    const mod = await import('../src/schema')
    expect(mod.schema).toHaveProperty('pages')
    expect(mod.schema).toHaveProperty('page_queries')
  })

  it('resolveWindow: last-30d with prev-period comparison', () => {
    const w = resolveWindow({
      preset: 'last-30d',
      comparison: 'prev-period',
      anchor: '2026-04-14',
    })
    expect(w.start).toBe('2026-03-16')
    expect(w.end).toBe('2026-04-14')
    expect(w.days).toBe(30)
    expect(w.comparison).toEqual({ start: '2026-02-14', end: '2026-03-15' })
  })

  it('resolveWindow: custom requires start/end', () => {
    expect(() => resolveWindow({ preset: 'custom' } as never)).toThrow(/custom/)
    const w = resolveWindow({ preset: 'custom', start: '2025-01-01', end: '2025-12-31' })
    expect(w.days).toBe(365)
  })

  it('resolveWindow: yoy produces a weekday-aligned year-shifted comparison window', () => {
    const w = resolveWindow({
      preset: 'last-30d',
      comparison: 'yoy',
      anchor: '2026-04-14',
    })
    expect(w.comparison).toEqual({
      start: '2025-03-17',
      end: '2025-04-15',
    })
  })

  it('scopeFor(page_keywords, window) emits date predicates', () => {
    const w = resolveWindow({ preset: 'last-7d', anchor: '2026-04-14' })
    const scope = scopeFor('page_queries', { window: w })
    expect(scope.wherePredicates).toHaveLength(2)
    expect(scope.window?.days).toBe(7)
  })

  it('drizzle builder compiles a typed select over the schema', async () => {
    const captured: Captured[] = []
    const runner = await createInsightRunner({
      db: stubDb(),
      conn: stubConn(captured),
    })

    const q = runner.db
      .select({
        query: queries.query,
        total: sum(queries.impressions),
      })
      .from(queries)
      .where(eq(queries.query, 'site seo'))
      .groupBy(queries.query)
      .orderBy(desc(sum(queries.impressions)))
      .limit(5)

    const { sql, params } = q.toSQL()
    expect(sql).toMatch(/select .* from "queries"/i)
    expect(sql).toContain('group by')
    expect(sql).toContain('order by')
    expect(params).toContain('site seo')
  })

  it('browser resolver compiles regex filters to regexp_matches', () => {
    const state = gsc
      .select(page)
      .where(and(
        between(date, '2026-04-01', '2026-04-30'),
        regex(page, '^https://example.com/blog/\\d+$'),
      ))
      .getState()

    const resolved = resolveToSQL(state, { adapter: pgResolverAdapter })
    expect(resolved.sql).toMatch(/regexp_matches/i)
    expect(resolved.params).toContain('^https://example.com/blog/\\d+$')
  })

  it('oR group emits parenthesized OR-joined predicates (regression: was silently AND-flattened)', () => {
    const state = gsc
      .select(query)
      .where(and(
        between(date, '2026-04-01', '2026-04-30'),
        or(contains(query, 'nuxt'), contains(query, 'seo'), contains(query, 'vue')),
      ))
      .getState()

    const resolved = resolveToSQL(state, { adapter: pgResolverAdapter })
    // All three OR branches present
    expect(resolved.params).toContain('%nuxt%')
    expect(resolved.params).toContain('%seo%')
    expect(resolved.params).toContain('%vue%')
    // Critical: an OR appears between the contains predicates inside parens.
    // Pre-fix the compiler joined every leaf with AND, returning ~zero rows
    // for any multi-keyword brand query.
    expect(resolved.sql).toMatch(/\(.+\bOR\b.+\bOR\b.+\)/i)
    // Date predicates remain AND'd at the top level
    expect(resolved.params).toContain('2026-04-01')
    expect(resolved.params).toContain('2026-04-30')
  })

  it('aND group still AND-joins leaves (no regression for default semantics)', () => {
    const state = gsc
      .select(query)
      .where(and(
        between(date, '2026-04-01', '2026-04-30'),
        contains(query, 'nuxt'),
        contains(page, '/docs/'),
      ))
      .getState()

    const resolved = resolveToSQL(state, { adapter: pgResolverAdapter })
    expect(resolved.params).toContain('%nuxt%')
    expect(resolved.params).toContain('%/docs/%')
    // No OR introduced when the user only used AND
    const wherePart = resolved.sql.split(/group by/i)[0]!
    expect(wherePart).not.toMatch(/\bOR\b/i)
  })

  it('createClient.query awaits stmt.close() before resolving (regression: floating close promise)', async () => {
    // A parameterised query prepares a statement and must `await stmt.close()`
    // in its finally. Pre-fix the close was fired but not awaited, so query()
    // resolved with cleanup still pending and any close() rejection became a
    // dropped unhandled rejection. Gate close() on a controlled promise: with
    // the fix, query() cannot resolve until the gate releases.
    let releaseClose!: () => void
    const closeGate = new Promise<void>((r) => {
      releaseClose = r
    })
    let closeFinished = false
    const conn = {
      async prepare() {
        return {
          async query() {
            return { toArray: () => [] }
          },
          async close() {
            await closeGate
            closeFinished = true
          },
        }
      },
    } as unknown as AsyncDuckDBConnection

    const client = await createClient({} as unknown as AsyncDuckDB, conn)
    let queryResolved = false
    const done = client.query('SELECT 1 WHERE id = ?', [1]).then(() => {
      queryResolved = true
    })

    // Drain all microtasks: prepare + stmt.query have settled and close() is now
    // parked on the gate. With the fix, query() is awaiting close() and stays
    // pending; pre-fix it has already resolved.
    await new Promise(r => setTimeout(r, 0))
    expect(closeFinished).toBe(false)
    expect(queryResolved).toBe(false)

    releaseClose()
    await done
    expect(closeFinished).toBe(true)
    expect(queryResolved).toBe(true)
  })

  it('sql template with typed Row works as the escape hatch', async () => {
    const captured: Captured[] = []
    const runner = await createInsightRunner({
      db: stubDb(),
      conn: stubConn(captured),
    })

    const { sql } = await import('drizzle-orm')
    interface Row { query: string, total: number }
    const rows = await runner.db.execute<Row>(sql`
      SELECT query, SUM(impressions) AS total
      FROM ${page_queries}
      WHERE date >= DATE '2026-04-01'
      GROUP BY query
      LIMIT 1
    `)
    expect(Array.isArray(rows)).toBe(true)
    expect(captured[0]?.sql).toMatch(/from\s+"page_queries"/i)
  })
})
