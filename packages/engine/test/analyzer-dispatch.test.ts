/**
 * Dispatch fallback: when a SQL analyzer's `build` throws
 * `UnresolvableDatasetError` (a cross-dimension query no stored table can
 * answer), `runAnalyzerFromSource` retries with the analyzer's row-query
 * variant — whose `BuilderState`s run through `queryRows`, which a composite
 * source routes to live GSC.
 */

import type { AnalysisQuerySource } from '../src/source/source-types'
import { describe, expect, it, vi } from 'vitest'
import { createAnalyzerRegistry, defineAnalyzer, runAnalyzerFromSource } from '../src/analyzer'

function unresolvable(): Error {
  const e = new Error('cross-dimension: [device] filtered by [query]')
  e.name = 'UnresolvableDatasetError'
  return e
}

function fakeSource(over: Partial<AnalysisQuerySource> = {}): AnalysisQuerySource {
  return {
    name: 'fake',
    kind: 'local',
    capabilities: { regex: true },
    queryRows: vi.fn(async () => [{ device: 'MOBILE', clicks: 7 }]),
    executeSql: vi.fn(async () => [{ device: 'MOBILE', clicks: 99 }]),
    ...over,
  } as AnalysisQuerySource
}

function defineDualAnalyzer(buildSqlThrows: Error | null) {
  return defineAnalyzer<any, any, any>({
    id: 'fixture',
    sqlRequires: ['executeSql'],
    buildSql() {
      if (buildSqlThrows)
        throw buildSqlThrows
      return { sql: 'SELECT 1', params: [], current: { table: 'devices', partitions: [] } }
    },
    reduceSql(rows) {
      return { results: rows as any[], meta: { via: 'sql' } }
    },
    buildRows() {
      return { main: { dimensions: ['device'], filter: {} } as any }
    },
    reduceRows(rows) {
      return { results: (Array.isArray(rows) ? rows : []) as any[], meta: { via: 'rows' } }
    },
  })
}

describe('runAnalyzerFromSource — cross-dimension fallback', () => {
  it('falls back to the rows variant when the SQL build throws UnresolvableDatasetError', async () => {
    const registry = createAnalyzerRegistry({ defined: [defineDualAnalyzer(unresolvable())] })
    const source = fakeSource()
    const result = await runAnalyzerFromSource(source, { type: 'fixture' } as any, registry)

    expect(result.meta?.via).toBe('rows')
    expect(source.queryRows).toHaveBeenCalledTimes(1)
    expect(source.executeSql).not.toHaveBeenCalled()
  })

  it('uses the SQL variant normally when the build succeeds', async () => {
    const registry = createAnalyzerRegistry({ defined: [defineDualAnalyzer(null)] })
    const source = fakeSource()
    const result = await runAnalyzerFromSource(source, { type: 'fixture' } as any, registry)

    expect(result.meta?.via).toBe('sql')
    expect(source.executeSql).toHaveBeenCalled()
  })

  it('propagates a non-UnresolvableDatasetError build failure unchanged', async () => {
    const registry = createAnalyzerRegistry({ defined: [defineDualAnalyzer(new Error('boom'))] })
    await expect(runAnalyzerFromSource(fakeSource(), { type: 'fixture' } as any, registry))
      .rejects
      .toThrow('boom')
  })

  it('propagates UnresolvableDatasetError when the analyzer has no rows variant', async () => {
    const sqlOnly = defineAnalyzer<any, any, any>({
      id: 'sql-only',
      sqlRequires: ['executeSql'],
      buildSql() { throw unresolvable() },
      reduceSql(rows) { return { results: rows as any[] } },
    })
    const registry = createAnalyzerRegistry({ defined: [sqlOnly] })
    await expect(runAnalyzerFromSource(fakeSource(), { type: 'sql-only' } as any, registry))
      .rejects
      .toThrow(/cross-dimension/)
  })
})
