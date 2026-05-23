/**
 * Unit tests for the OPFS attach module.
 *
 * Verifies the content-addressed cache (filename embeds `contentHash` so a
 * cache hit is filename-existence + size match — no SHA recomputation), stale-
 * entry sweep on re-attach, quota degradation, and view tear-down. The REAL
 * OPFS round-trip (`navigator.storage.getDirectory` + DuckDB-WASM
 * `BROWSER_FSACCESS`) needs a browser and is covered by
 * `poc/iceberg/browser/index.html`.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachOpfsParquetTables, OpfsQuotaExceededError } from '../src/opfs'

// ── in-memory OPFS fake ─────────────────────────────────────────────────────

function makeFakeOpfs(opts: { quotaBytes?: number } = {}) {
  const files = new Map<string, Uint8Array>()
  let used = 0
  const quota = opts.quotaBytes ?? Infinity

  function fileHandle(name: string): FileSystemFileHandle {
    return {
      kind: 'file',
      name,
      async getFile() {
        const bytes = files.get(name) ?? new Uint8Array()
        return {
          size: bytes.byteLength,
          async arrayBuffer() {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          },
        } as unknown as File
      },
      async createWritable() {
        let pending: Uint8Array = new Uint8Array()
        return {
          async write(data: ArrayBuffer | Uint8Array) {
            pending = data instanceof Uint8Array ? data : new Uint8Array(data)
          },
          async close() {
            if (used + pending.byteLength > quota) {
              const err = new Error('quota exceeded')
              err.name = 'QuotaExceededError'
              throw err
            }
            const prev = files.get(name)
            if (prev)
              used -= prev.byteLength
            files.set(name, pending)
            used += pending.byteLength
          },
          async abort() {},
        } as unknown as FileSystemWritableFileStream
      },
    } as unknown as FileSystemFileHandle
  }

  const root = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) {
        const err = new Error('not found')
        err.name = 'NotFoundError'
        throw err
      }
      return fileHandle(name)
    },
    async removeEntry(name: string) {
      const prev = files.get(name)
      if (prev)
        used -= prev.byteLength
      files.delete(name)
    },
    async* keys() {
      yield* files.keys()
    },
  } as unknown as FileSystemDirectoryHandle

  return {
    root,
    files,
    get used() {
      return used
    },
  }
}

function installNavigatorStorage(root: FileSystemDirectoryHandle): void {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => root,
      persist: async () => true,
      persisted: async () => false,
      estimate: async () => ({ usage: 0, quota: 1e9 }),
    },
  })
}

function stubDuckDb(): {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  registerFileHandle: ReturnType<typeof vi.fn>
  viewSql: string[]
} {
  const registerFileHandle = vi.fn(async () => {})
  const dropFiles = vi.fn(async () => {})
  const viewSql: string[] = []
  const query = vi.fn(async (sql: string) => {
    viewSql.push(sql)
    return { toArray: () => [] }
  })
  return {
    db: { registerFileHandle, dropFiles } as unknown as AsyncDuckDB,
    conn: { query } as unknown as AsyncDuckDBConnection,
    registerFileHandle,
    viewSql,
  }
}

function okFetch(payload: Uint8Array): typeof fetch {
  return vi.fn(async () => new Response(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength), { status: 200 })) as unknown as typeof fetch
}

/** Replicates the 16-hex-char slug the module derives from `contentHash`. */
async function expectedSlug(contentHash: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contentHash))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < 8; i++)
    hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('attachOpfsParquetTables', () => {
  it('downloads, writes to OPFS, registers + creates a view', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, registerFileHandle, viewSql } = stubDuckDb()
    const payload = new Uint8Array([1, 2, 3, 4, 5])

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{
        table: 'pages',
        files: [{ url: '/api/r2-data/pages-0.parquet', bytes: 5, contentHash: 'iceberg/abc.parquet' }],
      }],
    })

    expect(handle.tables).toEqual(['pages'])
    expect(handle.degradedTables).toEqual([])
    expect(handle.bytesAttached).toBe(5)
    expect(registerFileHandle).toHaveBeenCalledOnce()
    expect(viewSql[0]).toContain('CREATE OR REPLACE VIEW main.pages')
    expect(opfs.files.size).toBe(1)
    const slug = await expectedSlug('iceberg/abc.parquet')
    expect([...opfs.files.keys()][0]).toBe(`gscdump-snapshot__pages_0_${slug}.parquet`)
  })

  it('serves a cache hit (filename + size) without re-downloading', async () => {
    const opfs = makeFakeOpfs()
    const payload = new Uint8Array([9, 9, 9])
    const slug = await expectedSlug('iceberg/queries-0.parquet')
    opfs.files.set(`gscdump-snapshot__queries_0_${slug}.parquet`, payload)
    installNavigatorStorage(opfs.root)
    const { db, conn } = stubDuckDb()
    const fetchSpy = okFetch(payload)

    const progress: string[] = []
    await attachOpfsParquetTables({
      db,
      conn,
      fetch: fetchSpy,
      tables: [{ table: 'queries', files: [{ url: '/x', bytes: 3, contentHash: 'iceberg/queries-0.parquet' }] }],
      onFileProgress: info => progress.push(info.outcome),
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(progress).toEqual(['cache-hit'])
  })

  it('re-downloads when the content hash changes (new filename)', async () => {
    const opfs = makeFakeOpfs()
    // Old snapshot's cached file under the OLD content hash.
    const oldSlug = await expectedSlug('iceberg/old.parquet')
    opfs.files.set(`gscdump-snapshot__pages_0_${oldSlug}.parquet`, new Uint8Array([0, 0, 0]))
    installNavigatorStorage(opfs.root)
    const { db, conn } = stubDuckDb()
    const fresh = new Uint8Array([7, 7, 7])
    const fetchSpy = okFetch(fresh)

    await attachOpfsParquetTables({
      db,
      conn,
      fetch: fetchSpy,
      tables: [{ table: 'pages', files: [{ url: '/x', bytes: 3, contentHash: 'iceberg/new.parquet' }] }],
    })

    expect(fetchSpy).toHaveBeenCalledOnce()
    // Stale entry swept; only the new file remains.
    expect(opfs.files.size).toBe(1)
    const newSlug = await expectedSlug('iceberg/new.parquet')
    expect([...opfs.files.keys()][0]).toBe(`gscdump-snapshot__pages_0_${newSlug}.parquet`)
  })

  it('re-downloads when a cached file has the wrong byte size (partial write)', async () => {
    const opfs = makeFakeOpfs()
    const slug = await expectedSlug('iceberg/pages-0.parquet')
    // Wrong size — looks like a torn write.
    opfs.files.set(`gscdump-snapshot__pages_0_${slug}.parquet`, new Uint8Array([0]))
    installNavigatorStorage(opfs.root)
    const { db, conn } = stubDuckDb()
    const fresh = new Uint8Array([1, 2, 3])
    const fetchSpy = okFetch(fresh)

    await attachOpfsParquetTables({
      db,
      conn,
      fetch: fetchSpy,
      tables: [{ table: 'pages', files: [{ url: '/x', bytes: 3, contentHash: 'iceberg/pages-0.parquet' }] }],
    })

    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('degrades a table on QuotaExceededError instead of crashing', async () => {
    // quota only fits the first table's file (5 bytes); the second (5 bytes) is evicted.
    const opfs = makeFakeOpfs({ quotaBytes: 5 })
    installNavigatorStorage(opfs.root)
    const { db, conn } = stubDuckDb()
    const payload = new Uint8Array([1, 2, 3, 4, 5])

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      fetchConcurrency: 1,
      tables: [
        { table: 'pages', files: [{ url: '/a', bytes: 5, contentHash: 'iceberg/a.parquet' }] },
        { table: 'queries', files: [{ url: '/b', bytes: 5, contentHash: 'iceberg/b.parquet' }] },
      ],
    })

    expect(handle.tables).toEqual(['pages'])
    expect(handle.degradedTables).toEqual(['queries'])
  })

  it('detach drops the views + registered files', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, viewSql } = stubDuckDb()
    const payload = new Uint8Array([4, 2])

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'pages', files: [{ url: '/x', bytes: 2, contentHash: 'iceberg/p.parquet' }] }],
    })
    await handle.detach()
    expect(viewSql.some(s => s.includes('DROP VIEW IF EXISTS main.pages'))).toBe(true)
    // idempotent
    await expect(handle.detach()).resolves.toBeUndefined()
  })
})

describe('opfsQuotaExceededError', () => {
  it('carries the degraded table list', () => {
    const err = new OpfsQuotaExceededError('full', ['page_queries'])
    expect(err.name).toBe('OpfsQuotaExceededError')
    expect(err.degradedTables).toEqual(['page_queries'])
  })
})
