import type { Row } from '@gscdump/engine/contracts'
import { encodeRowsToParquet } from '@gscdump/engine/hyparquet'
import { tableFromIPC } from '@uwdata/flechette'
import { describe, expect, it, vi } from 'vitest'
import { assertWorkerReadBudget, createDucklingsExecutor, createDucklingsRowCache, DuckDBServiceTimeoutError, mapLimit, rowsToArrowIPCChunks, withDuckDBDeadline } from '../src/workers-duckdb'

describe('withDuckDBDeadline', () => {
  it('resolves when the op finishes before the deadline', async () => {
    const result = await withDuckDBDeadline(Promise.resolve('ok'), 1000)
    expect(result).toBe('ok')
  })

  it('rejects with a typed timeout error when the op stalls past the deadline', async () => {
    // A never-resolving op stands in for a hung DUCKDB_SVC RPC.
    const stalled = new Promise<string>(() => {})
    await expect(withDuckDBDeadline(stalled, 20)).rejects.toBeInstanceOf(DuckDBServiceTimeoutError)
  })

  it('surfaces the timeout fast — never rides the wall ceiling', async () => {
    const stalled = new Promise<string>(() => {})
    const started = Date.now()
    await expect(withDuckDBDeadline(stalled, 30)).rejects.toBeInstanceOf(DuckDBServiceTimeoutError)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('propagates the op rejection unchanged when it fails before the deadline', async () => {
    const boom = new Error('duckdb binder error')
    await expect(withDuckDBDeadline(Promise.reject(boom), 1000)).rejects.toBe(boom)
  })

  it('rejects immediately when the caller signal is already aborted', async () => {
    const stalled = new Promise<string>(() => {})
    await expect(withDuckDBDeadline(stalled, 1000, AbortSignal.abort())).rejects.toBeDefined()
  })

  it('rejects when the caller signal aborts mid-flight', async () => {
    const stalled = new Promise<string>(() => {})
    const ctrl = new AbortController()
    const race = withDuckDBDeadline(stalled, 5000, ctrl.signal)
    ctrl.abort()
    await expect(race).rejects.toBeDefined()
  })

  it('removes the abort listener when a stalled RPC times out', async () => {
    const stalled = new Promise<string>(() => {})
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')

    await expect(withDuckDBDeadline(stalled, 20, controller.signal)).rejects.toBeInstanceOf(DuckDBServiceTimeoutError)

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('worker read guardrails', () => {
  it('rejects file sets over the Worker file budget', () => {
    expect(() => assertWorkerReadBudget({
      fileKeys: { FILES: Array.from({ length: 4 }, (_, i) => `k${i}`) },
      maxFiles: 3,
    })).toThrow(/4 files/)
  })

  it('rejects known byte sizes over the Worker byte budget', () => {
    expect(() => assertWorkerReadBudget({
      fileKeys: { FILES: ['a', 'b'] },
      sizes: { a: 60, b: 50 },
      maxBytes: 100,
    })).toThrow(/110 bytes/)
  })

  it('runs limited work without exceeding the concurrency cap', async () => {
    let active = 0
    let maxActive = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return value * 2
    })

    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('drains in-flight work before surfacing a worker failure', async () => {
    const boom = new Error('read failed')
    let release!: () => void
    const slow = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: number[] = []
    let rejected = false
    const pending = mapLimit([0, 1, 2], 2, async (value) => {
      started.push(value)
      if (value === 0)
        throw boom
      await slow
      return value
    })
    void pending.catch(() => {
      rejected = true
    })

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(rejected).toBe(false)
    expect(started).toEqual([0, 1])

    release()
    await expect(pending).rejects.toBe(boom)
  })

  it('rejects oversized executor plans before any R2 read or DuckDB RPC', async () => {
    const runSQL = vi.fn()
    const read = vi.fn()
    const executor = createDucklingsExecutor({
      DUCKDB_SVC: { runSQL, ping: vi.fn() },
    } as any)

    await expect(executor.execute({
      sql: 'SELECT * FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: Array.from({ length: 97 }, (_, i) => `k${i}`) },
      dataSource: { read },
      table: 'pages',
    })).rejects.toThrow(/97 files/)

    expect(read).not.toHaveBeenCalled()
    expect(runSQL).not.toHaveBeenCalled()
  })

  it('rejects invalid RPC timeout configuration', () => {
    expect(() => createDucklingsExecutor({} as any, { rpcTimeoutMs: 0 })).toThrow(/positive finite number/)
    expect(() => createDucklingsExecutor({} as any, { rpcTimeoutMs: Number.NaN })).toThrow(/positive finite number/)
  })

  it('rejects oversized known byte plans before any R2 object GET', async () => {
    const runSQL = vi.fn()
    const read = vi.fn()
    const head = vi.fn(async () => ({ bytes: 8 * 1024 * 1024 }))
    const executor = createDucklingsExecutor({
      DUCKDB_SVC: { runSQL, ping: vi.fn() },
    } as any)

    await expect(executor.execute({
      sql: 'SELECT * FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: Array.from({ length: 9 }, (_, i) => `k${i}`) },
      dataSource: { read, head },
      table: 'pages',
    })).rejects.toThrow(/byte Worker budget/)

    expect(head).toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(runSQL).not.toHaveBeenCalled()
  })
})

describe('ducklings row cache', () => {
  it('owns capacity and eviction per cache instance', () => {
    const first = createDucklingsRowCache(64)
    const second = createDucklingsRowCache(64)
    const row = [{ value: 1 }]

    first.put('a', row)
    expect(first.get('a')).toBe(row)
    expect(second.get('a')).toBeUndefined()

    first.put('b', [{ value: 2 }])
    expect(first.get('a')).toBeUndefined()
    expect(first.get('b')).toEqual([{ value: 2 }])
  })
})

describe('createDucklingsExecutor Arrow transport', () => {
  function largePageRows(count: number, width: number): Row[] {
    return Array.from({ length: count }, (_, i) => ({
      url: `/chunked-${i}-${'x'.repeat(width)}`,
      date: '2026-01-01',
      clicks: i + 1,
      impressions: i + 10,
      sum_position: i + 0.5,
    }))
  }

  it('decodes parquet and ships an Arrow IPC stream, not JS rows, to DUCKDB_SVC', async () => {
    const parquet = encodeRowsToParquet('pages', [
      { url: '/a', date: '2026-01-01', clicks: 3, impressions: 10, sum_position: 1.2 },
      { url: '/b', date: '2026-01-01', clicks: 1, impressions: 5, sum_position: 4 },
    ])
    const runSQL = vi.fn(async () => ({ rows: [], sql: '' }))
    const read = vi.fn(async () => parquet)
    const executor = createDucklingsExecutor({
      DUCKDB_SVC: { runSQL, ping: vi.fn() },
    } as any, { rpcTimeoutMs: 120_000 })
    const earliestDeadline = Date.now() + 120_000

    await executor.execute({
      sql: 'SELECT * FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: ['k0'] },
      placeholderTables: { FILES: 'pages' },
      dataSource: { read },
      table: 'pages',
    })

    expect(runSQL).toHaveBeenCalledOnce()
    const arg = runSQL.mock.calls[0]![0] as { sql: string, tables: Record<string, { ipc: Uint8Array, rows?: unknown }>, deadlineAt?: number }
    // The `{{FILES}}` placeholder is rewritten to the temp table name.
    expect(arg.sql).not.toContain('{{FILES}}')
    expect(arg.deadlineAt).toEqual(expect.any(Number))
    expect(arg.deadlineAt).toBeGreaterThanOrEqual(earliestDeadline)
    const specs = Object.values(arg.tables)
    expect(specs).toHaveLength(1)
    // Columnar Arrow IPC crosses the binding — never JS row objects.
    expect(specs[0]!.ipc).toBeInstanceOf(Uint8Array)
    expect(specs[0]!.rows).toBeUndefined()
    // The shipped IPC round-trips to the two decoded parquet rows.
    const table = tableFromIPC(specs[0]!.ipc)
    expect(table.numRows).toBe(2)
    expect(table.toArray().map(r => r.url).sort()).toEqual(['/a', '/b'])
  })

  it('skips R2 HEAD and GET after an unfiltered file reaches the decoded cache', async () => {
    const parquet = encodeRowsToParquet('pages', [
      { url: '/cached', date: '2026-01-01', clicks: 1, impressions: 2, sum_position: 3 },
    ])
    const runSQL = vi.fn(async () => ({ rows: [], sql: '' }))
    const read = vi.fn(async () => parquet)
    const head = vi.fn(async () => ({ bytes: parquet.byteLength }))
    const rowCache = createDucklingsRowCache()
    const executor = createDucklingsExecutor({
      DUCKDB_SVC: { runSQL, ping: vi.fn() },
    } as any, { rowCache })
    const input = {
      sql: 'SELECT * FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: ['cached-k0'] },
      placeholderTables: { FILES: 'pages' as const },
      dataSource: { read, head },
      table: 'pages' as const,
    }

    await executor.execute(input)
    await executor.execute(input)

    expect(head).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
    expect(runSQL).toHaveBeenCalledTimes(2)
  })

  it('chunks large Arrow IPC requests through staged service calls and reassembles the rows', async () => {
    const rows = largePageRows(24, 1200)
    const parquet = encodeRowsToParquet('pages', rows)
    const staged: Record<string, Row[]> = {}
    const uploadedRows: Row[] = []
    const stageArrowTable = vi.fn(async ({ table, ipc }: { table: string, ipc: Uint8Array }) => {
      const decoded = tableFromIPC(ipc).toArray() as Row[]
      staged[table] ??= []
      staged[table]!.push(...decoded)
      uploadedRows.push(...decoded)
    })
    const dropTables = vi.fn(async ({ tables }: { tables: string[] }) => {
      for (const table of tables)
        delete staged[table]
    })
    const runSQL = vi.fn(async (args: { sql: string, tables?: unknown, deadlineAt?: number }) => {
      expect(args.tables).toBeUndefined()
      expect(args.deadlineAt).toEqual(expect.any(Number))
      const tableName = Object.keys(staged)[0]!
      const tableRows = staged[tableName]!
      return {
        rows: [{
          rowCount: tableRows.length,
          firstUrl: tableRows[0]!.url,
        }],
        sql: args.sql,
      }
    })
    const read = vi.fn(async () => parquet)
    const executor = createDucklingsExecutor({
      DUCKDB_SVC: { runSQL, stageArrowTable, dropTables, ping: vi.fn() },
    } as any, {
      ipcChunkBytes: 12 * 1024,
    })

    const result = await executor.execute({
      sql: 'SELECT count(*) AS rowCount FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: ['chunked-k0'] },
      placeholderTables: { FILES: 'pages' },
      dataSource: { read },
      table: 'pages',
    })

    expect(stageArrowTable.mock.calls.length).toBeGreaterThan(1)
    expect(runSQL).toHaveBeenCalledOnce()
    expect(dropTables).toHaveBeenCalledOnce()
    expect(runSQL.mock.calls[0]![0].sql).not.toContain('{{FILES}}')
    expect(result.rows[0]).toMatchObject({
      rowCount: rows.length,
    })
    expect(uploadedRows.map(row => row.url).sort()).toEqual(rows.map(row => row.url).sort())
    expect(Object.keys(staged)).toHaveLength(0)
  })

  it('drops staged Arrow tables even when the caller aborts after staging starts', async () => {
    const rows = largePageRows(24, 1200)
    const parquet = encodeRowsToParquet('pages', rows)
    const controller = new AbortController()
    const staged = new Set<string>()
    const stageArrowTable = vi.fn(async ({ table }: { table: string, ipc: Uint8Array }) => {
      staged.add(table)
      controller.abort()
    })
    const dropTables = vi.fn(async ({ tables }: { tables: string[] }) => {
      for (const table of tables)
        staged.delete(table)
    })
    const runSQL = vi.fn(async () => ({ rows: [], sql: '' }))
    const read = vi.fn(async () => parquet)
    const executor = createDucklingsExecutor({
      DUCKDB_SVC: { runSQL, stageArrowTable, dropTables, ping: vi.fn() },
    } as any, {
      ipcChunkBytes: 12 * 1024,
    })

    await expect(executor.execute({
      sql: 'SELECT count(*) AS rowCount FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: ['chunked-abort-k0'] },
      placeholderTables: { FILES: 'pages' },
      dataSource: { read },
      table: 'pages',
      signal: controller.signal,
    })).rejects.toBeDefined()

    expect(stageArrowTable).toHaveBeenCalledOnce()
    expect(runSQL).not.toHaveBeenCalled()
    expect(dropTables).toHaveBeenCalledOnce()
    expect(staged.size).toBe(0)
  })

  it('rejects over-budget encoded requests before any DUCKDB_SVC call', async () => {
    const rows = largePageRows(4, 800)
    const parquet = encodeRowsToParquet('pages', rows)
    const runSQL = vi.fn()
    const stageArrowTable = vi.fn()
    const dropTables = vi.fn()
    const read = vi.fn(async () => parquet)
    const executor = createDucklingsExecutor({
      DUCKDB_SVC: { runSQL, stageArrowTable, dropTables, ping: vi.fn() },
    } as any, {
      ipcChunkBytes: 1024 * 1024,
      ipcTotalBytes: 1,
    })

    await expect(executor.execute({
      sql: 'SELECT * FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: ['chunked-budget-k0'] },
      placeholderTables: { FILES: 'pages' },
      dataSource: { read },
      table: 'pages',
    })).rejects.toThrow(/service-binding transport budget/)

    expect(read).toHaveBeenCalledOnce()
    expect(stageArrowTable).not.toHaveBeenCalled()
    expect(runSQL).not.toHaveBeenCalled()
    expect(dropTables).not.toHaveBeenCalled()
  })

  it('keeps chunked sidecar schemas stable across every IPC chunk', () => {
    const rows = Array.from({ length: 16 }, (_, i) => ({
      id: i,
      ...(i % 3 === 0 ? { label: `label-${i}-${'x'.repeat(160)}` } : {}),
    }))
    const chunks = rowsToArrowIPCChunks(rows, undefined, { maxChunkBytes: 1400, placeholder: 'EXTRA' })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const table = tableFromIPC(chunk.ipc)
      expect(table.schema.fields.map(f => f.name).sort()).toEqual(['id', 'label'])
    }
  })
})
