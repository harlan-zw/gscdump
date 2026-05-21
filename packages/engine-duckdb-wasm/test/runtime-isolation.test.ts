/**
 * Stale-version isolation, incomplete-coverage refusal, and active-query abort
 * pass-through for the browser DuckDB-WASM runtime. Runs in Node against stub
 * db/conn objects that record the SQL/cancel calls they see.
 *
 * SPEC.md workstream F: a runtime attached for one searchType/date manifest
 * must not silently serve another, and a query for a table outside the
 * attached set must fail-fast rather than return partial data.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Analyzer } from '@gscdump/engine/analyzer'

import { createAnalyzerRegistry } from '@gscdump/engine/analyzer'
import { describe, expect, it, vi } from 'vitest'

import { attachParquetUrlTables, createBrowserAnalysisRuntime } from '../src/runtime'

function headResponse(bytes = 1): Response {
  return new Response(null, {
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(bytes),
    },
  })
}

function okFetch(bytes = 1): typeof fetch {
  return vi.fn(async () => headResponse(bytes)) as unknown as typeof fetch
}

function stubDb(): AsyncDuckDB {
  return {
    registerFileBuffer: vi.fn(async () => {}),
    registerFileURL: vi.fn(async () => {}),
    dropFiles: vi.fn(async () => null),
    terminate: vi.fn(async () => {}),
  } as unknown as AsyncDuckDB
}

/**
 * A minimal SQL analyzer whose plan references a single parquet table via a
 * `{{FILES}}` placeholder. `runAnalyzerFromSource` turns `current.table` into
 * a fileSet, which `createAttachedTableSource` checks against the runtime's
 * attached set — the seam under test for incomplete-coverage refusal.
 */
function sqlAnalyzerForTable(table: 'queries' | 'page_queries'): Analyzer {
  return {
    id: 'data-query',
    requires: ['executeSql', 'fileSets'],
    build: () => ({
      kind: 'sql',
      sql: 'SELECT 1 AS n FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      current: { table, partitions: [] },
    }),
    reduce: rows => ({ results: rows as unknown }),
  }
}

const queryParams: AnalysisParams = { type: 'data-query' }

describe('browser runtime stale searchType/date isolation', () => {
  it('isStale: undefined version compares equal to undefined expected (no-version no-op)', () => {
    const runtime = createBrowserAnalysisRuntime({ db: stubDb(), conn: {} as AsyncDuckDBConnection })
    expect(runtime.isStale(undefined)).toBe(false)
  })

  it('isStale: returns true when expected version differs from attached version', () => {
    const runtime = createBrowserAnalysisRuntime(
      { db: stubDb(), conn: {} as AsyncDuckDBConnection },
      { version: 'v-2026-05-21-web' },
    )
    expect(runtime.isStale('v-2026-05-21-web')).toBe(false)
    expect(runtime.isStale('v-2026-05-20-web')).toBe(true)
    // searchType swap surfaces as a fresh manifest version too
    expect(runtime.isStale('v-2026-05-21-image')).toBe(true)
    expect(runtime.isStale(undefined)).toBe(true)
  })

  it('setVersion: updates the cached version in-place so later isStale checks track it', () => {
    const runtime = createBrowserAnalysisRuntime(
      { db: stubDb(), conn: {} as AsyncDuckDBConnection },
      { version: 1 },
    )
    expect(runtime.isStale(1)).toBe(false)
    runtime.setVersion(2)
    expect(runtime.isStale(1)).toBe(true)
    expect(runtime.isStale(2)).toBe(false)
    runtime.setVersion(undefined)
    expect(runtime.isStale(undefined)).toBe(false)
    expect(runtime.isStale(2)).toBe(true)
  })

  it('attachParquetUrlTables: round-trips the advisory version onto the handle', async () => {
    const handle = await attachParquetUrlTables({
      db: stubDb(),
      conn: { query: vi.fn(async () => ({ toArray: () => [] })) } as unknown as AsyncDuckDBConnection,
      tables: [{ table: 'pages', urls: ['https://x.test/1'] }],
      fetch: okFetch(1),
      version: 'manifest-v7',
    })
    expect(handle.version).toBe('manifest-v7')
    expect(handle.tables).toEqual(['pages'])
  })

  it('attachParquetUrlTables: handle version is undefined when caller omits it', async () => {
    const handle = await attachParquetUrlTables({
      db: stubDb(),
      conn: { query: vi.fn(async () => ({ toArray: () => [] })) } as unknown as AsyncDuckDBConnection,
      tables: [{ table: 'pages', urls: ['https://x.test/1'] }],
      fetch: okFetch(1),
    })
    expect(handle.version).toBeUndefined()
  })
})

describe('browser runtime incomplete-coverage refusal', () => {
  it('analyze: fast-fails with AttachedTableMissingError when the plan needs a table outside the attached set', async () => {
    const query = vi.fn(async () => ({ toArray: () => [{ n: 1 }] }))
    const conn = { query } as unknown as AsyncDuckDBConnection
    // Site has only `keywords` parquet attached; analyzer wants `page_keywords`.
    const runtime = createBrowserAnalysisRuntime(
      { db: stubDb(), conn },
      { attachedTables: ['queries'] },
    )
    const registry = createAnalyzerRegistry({ sql: [sqlAnalyzerForTable('page_queries')] })

    await expect(runtime.analyze(queryParams, registry)).rejects.toMatchObject({
      name: 'AttachedTableMissingError',
      missing: ['page_queries'],
    })
    // Refusal happens before any SQL hits the connection.
    expect(query).not.toHaveBeenCalled()
  })

  it('analyze: executes when the required table is in the attached set', async () => {
    const query = vi.fn(async () => ({ toArray: () => [{ n: 1 }] }))
    const conn = { query } as unknown as AsyncDuckDBConnection
    const runtime = createBrowserAnalysisRuntime(
      { db: stubDb(), conn },
      { attachedTables: ['queries', 'page_queries'] },
    )
    const registry = createAnalyzerRegistry({ sql: [sqlAnalyzerForTable('page_queries')] })

    const result = await runtime.analyze(queryParams, registry)
    expect(result.results).toEqual([{ n: 1 }])
    expect(query).toHaveBeenCalledTimes(1)
    // Placeholder rewritten to the attached view reference.
    expect(query.mock.calls[0]![0]).toContain('main.page_queries')
  })

  it('analyze: setAttachedTables narrows coverage and a now-missing table fast-fails', async () => {
    const query = vi.fn(async () => ({ toArray: () => [{ n: 1 }] }))
    const conn = { query } as unknown as AsyncDuckDBConnection
    const runtime = createBrowserAnalysisRuntime(
      { db: stubDb(), conn },
      { attachedTables: ['queries', 'page_queries'] },
    )
    const registry = createAnalyzerRegistry({ sql: [sqlAnalyzerForTable('page_queries')] })

    await expect(runtime.analyze(queryParams, registry)).resolves.toBeTruthy()

    // Re-attach against a manifest that dropped page_keywords coverage.
    runtime.setAttachedTables(['queries'])
    await expect(runtime.analyze(queryParams, registry)).rejects.toMatchObject({
      name: 'AttachedTableMissingError',
      missing: ['page_queries'],
    })
    // Only the first (successful) analyze reached the connection.
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('browser runtime active-query abort cancel pass-through', () => {
  it('aborting the active query triggers conn.cancelSent()', async () => {
    let releaseQuery: (() => void) | null = null
    const cancelSent = vi.fn(async () => {})
    const query = vi.fn(async (sql: string) => {
      if (sql === 'slow') {
        await new Promise<void>((resolve) => {
          releaseQuery = resolve
        })
      }
      return { toArray: () => [{ sql }] }
    })
    const conn = {
      query,
      cancelSent,
      close: vi.fn(async () => {}),
    } as unknown as AsyncDuckDBConnection
    const runtime = createBrowserAnalysisRuntime({ db: stubDb(), conn })

    const controller = new AbortController()
    const active = runtime.query('slow', undefined, controller.signal)
    // Let the query reach the connection so it is the active (not queued) one.
    await Promise.resolve()
    await Promise.resolve()
    expect(query).toHaveBeenCalledTimes(1)

    controller.abort()
    // cancelOnAbort registers an abort listener that pings the connection.
    expect(cancelSent).toHaveBeenCalledTimes(1)

    await expect(active).rejects.toMatchObject({ name: 'AbortError' })

    // Connection still usable after the cancelled query unblocks.
    releaseQuery?.()
    await expect(runtime.query('next')).resolves.toMatchObject({ rows: [{ sql: 'next' }] })
  })
})
