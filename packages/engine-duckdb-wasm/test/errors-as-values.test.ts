import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

import { isErr, isOk } from 'gscdump/result'
import { describe, expect, it, vi } from 'vitest'
import {
  attachParquetUrlTables,
  attachParquetUrlTablesResult,
  BrowserAttachBudgetExceededError,
  isBrowserAttachError,
} from '../src/runtime'

function stubDb(): AsyncDuckDB {
  return {
    registerFileBuffer: vi.fn(async () => {}),
    registerFileURL: vi.fn(async () => {}),
    dropFiles: vi.fn(async () => null),
  } as unknown as AsyncDuckDB
}

function stubConn(): AsyncDuckDBConnection {
  return { query: vi.fn(async () => ({ toArray: () => [] })) } as unknown as AsyncDuckDBConnection
}

function headResponse(bytes = 1): Response {
  return new Response(null, {
    headers: { 'accept-ranges': 'bytes', 'content-length': String(bytes) },
  })
}

describe('attachParquetUrlTablesResult — errors as values', () => {
  it('returns a typed maxFiles budget error instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => headResponse(1)) as unknown as typeof fetch
    const result = await attachParquetUrlTablesResult({
      db: stubDb(),
      conn: stubConn(),
      tables: [{ table: 'pages', urls: ['https://x.test/1', 'https://x.test/2'] }],
      fetch: fetchImpl,
      maxFiles: 1,
    })

    expect(isErr(result)).toBe(true)
    if (isErr(result)) {
      expect(result.error.kind).toBe('browser-attach-budget-exceeded')
      expect(result.error.budget).toBe('maxFiles')
      expect(isBrowserAttachError(result.error)).toBe(true)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns a typed maxBytes budget error for hinted byte plans', async () => {
    const result = await attachParquetUrlTablesResult({
      db: stubDb(),
      conn: stubConn(),
      tables: [{ table: 'pages', urls: ['https://x.test/1.parquet?s=20.sig'] }],
      fetch: vi.fn(async () => headResponse(1)) as unknown as typeof fetch,
      maxBytes: 10,
    })

    expect(isErr(result)).toBe(true)
    if (isErr(result)) {
      expect(result.error.budget).toBe('maxBytes')
      expect(result.error.message).toContain('hinted bytes')
    }
  })

  it('returns a typed maxBytes budget error for the running byte plan mid-stream', async () => {
    const result = await attachParquetUrlTablesResult({
      db: stubDb(),
      conn: stubConn(),
      tables: [{ table: 'pages', urls: ['https://x.test/1', 'https://x.test/2'] }],
      fetch: vi.fn(async () => headResponse(8)) as unknown as typeof fetch,
      fetchConcurrency: 1,
      maxBytes: 10,
    })

    expect(isErr(result)).toBe(true)
    if (isErr(result))
      expect(result.error.message).toContain('planned')
  })

  it('returns ok with an attached-tables handle on a clean attach', async () => {
    const result = await attachParquetUrlTablesResult({
      db: stubDb(),
      conn: stubConn(),
      tables: [{ table: 'pages', urls: ['https://x.test/1'] }],
      fetch: vi.fn(async () => headResponse(1)) as unknown as typeof fetch,
      maxFiles: 10,
      maxBytes: 100,
    })

    expect(isOk(result)).toBe(true)
    if (isOk(result))
      expect(result.value.tables).toEqual(['pages'])
  })

  it('throwing wrapper re-raises budget errors as BrowserAttachBudgetExceededError', async () => {
    await expect(attachParquetUrlTables({
      db: stubDb(),
      conn: stubConn(),
      tables: [{ table: 'pages', urls: ['https://x.test/1', 'https://x.test/2'] }],
      fetch: vi.fn(async () => headResponse(1)) as unknown as typeof fetch,
      maxFiles: 1,
    })).rejects.toBeInstanceOf(BrowserAttachBudgetExceededError)
  })
})
