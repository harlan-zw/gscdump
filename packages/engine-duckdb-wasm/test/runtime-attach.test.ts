import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

import { describe, expect, it, vi } from 'vitest'
import { attachParquetUrlTables, BrowserAttachBudgetExceededError, createBrowserAnalysisRuntime } from '../src/runtime'

function stubDb(): {
  db: AsyncDuckDB
  registerFileBuffer: ReturnType<typeof vi.fn>
  registerFileURL: ReturnType<typeof vi.fn>
  dropFiles: ReturnType<typeof vi.fn>
} {
  const registerFileBuffer = vi.fn(async (_name: string, _bytes: Uint8Array) => {})
  const registerFileURL = vi.fn(async (_name: string, _url: string, _proto: unknown, _directIO: boolean) => {})
  const dropFiles = vi.fn(async (_names?: string[]) => null)
  return {
    db: { registerFileBuffer, registerFileURL, dropFiles } as unknown as AsyncDuckDB,
    registerFileBuffer,
    registerFileURL,
    dropFiles,
  }
}

function stubConn(): { conn: AsyncDuckDBConnection, query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (_sql: string) => ({ toArray: () => [] }))
  return {
    conn: { query } as unknown as AsyncDuckDBConnection,
    query,
  }
}

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

describe('runtime parquet URL attachment', () => {
  it('bounds concurrent parquet URL preflights before registering HTTP files', async () => {
    const { db, registerFileBuffer, registerFileURL } = stubDb()
    const { conn, query } = stubConn()
    let active = 0
    let maxActive = 0
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD')
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return headResponse(1)
    }) as unknown as typeof fetch

    await attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/1', 'https://x.test/2', 'https://x.test/3', 'https://x.test/4'] }],
      fetch: fetchImpl,
      fetchConcurrency: 2,
      maxFiles: 10,
      maxBytes: 100,
    })

    expect(maxActive).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(registerFileBuffer).not.toHaveBeenCalled()
    expect(registerFileURL).toHaveBeenCalledTimes(4)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects file sets above the browser attach budget before fetching', async () => {
    const { db } = stubDb()
    const { conn } = stubConn()
    const fetchImpl = okFetch()

    await expect(attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/1', 'https://x.test/2'] }],
      fetch: fetchImpl,
      maxFiles: 1,
    })).rejects.toBeInstanceOf(BrowserAttachBudgetExceededError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects hinted byte plans above budget before fetching', async () => {
    const { db } = stubDb()
    const { conn } = stubConn()
    const fetchImpl = okFetch()

    await expect(attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/1.parquet?s=20.sig'] }],
      fetch: fetchImpl,
      maxBytes: 10,
    })).rejects.toBeInstanceOf(BrowserAttachBudgetExceededError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects authoritative preflight bytes above budget before registering files', async () => {
    const { db, registerFileURL } = stubDb()
    const { conn, query } = stubConn()
    const fetchImpl = okFetch(8)

    await expect(attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/1', 'https://x.test/2'] }],
      fetch: fetchImpl,
      fetchConcurrency: 1,
      maxBytes: 10,
    })).rejects.toBeInstanceOf(BrowserAttachBudgetExceededError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(registerFileURL).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('passes the attach abort signal into parquet preflights', async () => {
    const { db } = stubDb()
    const { conn } = stubConn()
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined
      return headResponse(1)
    }) as unknown as typeof fetch

    await attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/1'] }],
      fetch: fetchImpl,
      signal: controller.signal,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(seenSignal?.aborted).toBe(false)
    controller.abort()
    expect(seenSignal?.aborted).toBe(true)
  })

  it('fails closed when a URL cannot prove range support', async () => {
    const { db, registerFileURL } = stubDb()
    const { conn, query } = stubConn()
    const fetchImpl = vi.fn(async () => new Response(null, {
      headers: { 'content-length': '10' },
    })) as unknown as typeof fetch

    const handle = await attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/1'] }],
      fetch: fetchImpl,
      maxBytes: 100,
    })

    expect(handle.tables).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(registerFileURL).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('uses a one-byte range probe when HEAD is unavailable', async () => {
    const { db, registerFileURL } = stubDb()
    const { conn, query } = stubConn()
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD')
        return new Response(null, { status: 405 })
      expect(init?.method).toBe('GET')
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-0')
      return new Response(new Uint8Array([1]), {
        status: 206,
        headers: {
          'content-range': 'bytes 0-0/12',
        },
      })
    }) as unknown as typeof fetch

    await attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/1'] }],
      fetch: fetchImpl,
      maxBytes: 100,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(registerFileURL).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('namespaces registered files per attach so overlapping attaches cannot reuse paths', async () => {
    const { db, registerFileURL } = stubDb()
    const { conn } = stubConn()
    const fetchImpl = okFetch(1)

    await attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/1'] }],
      fetch: fetchImpl,
    })
    await attachParquetUrlTables({
      db,
      conn,
      tables: [{ table: 'pages', urls: ['https://x.test/2'] }],
      fetch: fetchImpl,
    })

    const names = registerFileURL.mock.calls.map(call => call[0])
    expect(names).toHaveLength(2)
    expect(names[0]).not.toBe(names[1])
  })

  it('drops registered files and created views when attach aborts during view creation', async () => {
    const { db, registerFileURL, dropFiles } = stubDb()
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('queries'))
        throw new DOMException('aborted', 'AbortError')
      return { toArray: () => [] }
    })
    const conn = { query } as unknown as AsyncDuckDBConnection
    const fetchImpl = okFetch(1)

    await expect(attachParquetUrlTables({
      db,
      conn,
      tables: [
        { table: 'pages', urls: ['https://x.test/1'] },
        { table: 'queries', urls: ['https://x.test/2'] },
      ],
      fetch: fetchImpl,
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(registerFileURL).toHaveBeenCalledTimes(2)
    expect(dropFiles).toHaveBeenCalledTimes(1)
    expect(dropFiles.mock.calls[0]![0]).toHaveLength(2)
    expect(query.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('main.pages'),
      expect.stringContaining('main.queries'),
      'DROP VIEW IF EXISTS main.pages',
    ])
  })
})

describe('browser runtime query isolation', () => {
  it('serializes ad-hoc queries on the shared DuckDB connection', async () => {
    const { db } = stubDb()
    let releaseFirst: (() => void) | null = null
    const query = vi.fn(async (sql: string) => {
      if (sql === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = () => {
            resolve()
          }
        })
      }
      return { toArray: () => [{ sql }] }
    })
    const conn = {
      query,
      cancelSent: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as AsyncDuckDBConnection
    const runtime = createBrowserAnalysisRuntime({ db, conn })

    const first = runtime.query('first')
    await Promise.resolve()
    await Promise.resolve()
    expect(query).toHaveBeenCalledTimes(1)
    const second = runtime.query('second')
    await Promise.resolve()

    expect(query).toHaveBeenCalledTimes(1)
    releaseFirst?.()

    await expect(first).resolves.toMatchObject({ rows: [{ sql: 'first' }] })
    await expect(second).resolves.toMatchObject({ rows: [{ sql: 'second' }] })
    expect(query.mock.calls.map(call => call[0])).toEqual(['first', 'second'])
  })

  it('does not cancel an active query when a queued query is aborted', async () => {
    const { db } = stubDb()
    let releaseFirst: (() => void) | null = null
    const cancelSent = vi.fn(async () => {})
    const query = vi.fn(async (sql: string) => {
      if (sql === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = () => {
            resolve()
          }
        })
      }
      return { toArray: () => [{ sql }] }
    })
    const conn = {
      query,
      cancelSent,
      close: vi.fn(async () => {}),
    } as unknown as AsyncDuckDBConnection
    const runtime = createBrowserAnalysisRuntime({ db, conn })

    const first = runtime.query('first')
    await Promise.resolve()
    await Promise.resolve()
    expect(query).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    const queued = runtime.query('queued', undefined, controller.signal)
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelSent).not.toHaveBeenCalled()
    releaseFirst?.()
    await expect(first).resolves.toMatchObject({ rows: [{ sql: 'first' }] })

    const third = runtime.query('third')
    await expect(third).resolves.toMatchObject({ rows: [{ sql: 'third' }] })
    expect(query.mock.calls.map(call => call[0])).toEqual(['first', 'third'])
    expect(cancelSent).not.toHaveBeenCalled()
  })
})
