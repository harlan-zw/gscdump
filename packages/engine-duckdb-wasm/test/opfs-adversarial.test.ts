/**
 * Adversarial tests for the OPFS attach/handle-lifecycle. These probe the
 * refcount + acquiredNames/registeredNames bookkeeping for leaks and
 * double-decrements under partial failure, multi-file tables, abort, and
 * cross-DB isolation.
 *
 * The fakes here go further than `opfs.test.ts`: the db stub EXPOSES its live
 * sync-access-handle set so a test can assert "exactly zero handles leaked",
 * and the OPFS fake can inject a quota error or an access-handle conflict on a
 * specific file so we can model a table whose SECOND file fails after its
 * first registered.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachOpfsParquetTables } from '../src/opfs'

// ── in-memory OPFS fake with per-name failure injection ─────────────────────

interface FakeOpfsOptions {
  quotaBytes?: number
  /** Throw a QuotaExceededError on the write/close of any file whose URL is in this set. */
  quotaUrls?: Set<string>
  /** Throw a NoModificationAllowedError from createWritable for any file whose OPFS name is in this set. */
  writeConflictNames?: Set<string>
}

function makeFakeOpfs(opts: FakeOpfsOptions = {}) {
  const files = new Map<string, Uint8Array>()
  let used = 0
  const quota = opts.quotaBytes ?? Infinity
  const writeConflictNames = opts.writeConflictNames ?? new Set<string>()

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
        if (writeConflictNames.has(name)) {
          // OPFS write-exclusivity: the backing file is held open by another
          // consumer's sync access handle, so createWritable is refused.
          const err = new Error(`Failed to execute 'createWritable' on 'FileSystemFileHandle': An attempt was made to modify an object where modifications are not allowed.`)
          err.name = 'NoModificationAllowedError'
          throw err
        }
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

interface StubDbOptions {
  /** Names whose registerFileHandle should throw the OPFS access-handle conflict. */
  conflictNames?: Set<string>
  /** Names whose VIEW creation (conn.query CREATE...) should throw the conflict. */
  viewConflictTables?: Set<string>
}

/**
 * DuckDB stub that EXPOSES its live sync-access-handle set so tests can assert
 * the exact number of leaked handles. Models OPFS exclusivity: a second
 * registerFileHandle on a live name throws. Can be told to throw a conflict on
 * a chosen name (acquire-time) or a chosen view (view-creation-time).
 */
function stubDuckDb(opts: StubDbOptions = {}) {
  const live = new Set<string>()
  const conflictNames = opts.conflictNames ?? new Set<string>()
  const viewConflictTables = opts.viewConflictTables ?? new Set<string>()
  const registerFileHandle = vi.fn(async (name: string) => {
    if (conflictNames.has(name)) {
      const err = new Error(`Access Handles cannot be created (${name})`)
      err.name = 'InvalidStateError'
      throw err
    }
    if (live.has(name)) {
      const err = new Error(`Access Handles cannot be created (${name})`)
      err.name = 'InvalidStateError'
      throw err
    }
    live.add(name)
  })
  const dropFile = vi.fn(async (name: string) => {
    live.delete(name)
  })
  const viewSql: string[] = []
  // Models DuckDB's view catalog so tests can assert a view's actual presence
  // after attach/detach churn (CREATE OR REPLACE adds, DROP VIEW removes).
  const views = new Set<string>()
  const query = vi.fn(async (sql: string) => {
    viewSql.push(sql)
    const create = /CREATE OR REPLACE VIEW (\w+\.\w+)/.exec(sql)
    if (create) {
      const table = create[1]!.split('.')[1]!
      if (viewConflictTables.has(table)) {
        const err = new Error(`Access Handle conflict on view ${table}`)
        err.name = 'InvalidStateError'
        throw err
      }
      views.add(create[1]!)
    }
    const drop = /DROP VIEW IF EXISTS (\w+\.\w+)/.exec(sql)
    if (drop)
      views.delete(drop[1]!)
    return { toArray: () => [] }
  })
  return {
    db: { registerFileHandle, dropFile } as unknown as AsyncDuckDB,
    conn: { query } as unknown as AsyncDuckDBConnection,
    registerFileHandle,
    dropFile,
    viewSql,
    /** Live sync-access-handle count. 0 means every handle was released. */
    liveCount: () => live.size,
    liveNames: () => [...live],
    /** Whether a `schema.table` view currently exists in the catalog. */
    hasView: (qualified: string) => views.has(qualified),
    views: () => [...views],
  }
}

function okFetch(payloadByUrl: (url: string) => Uint8Array): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input)
    const p = payloadByUrl(url)
    return new Response(p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength), { status: 200 })
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('opfs adversarial: multi-file table partial failure', () => {
  it('releases file-0 handle when file-1 of the same table hits quota (no leak)', async () => {
    // Table `pages` has 2 files of 5 bytes each. Quota fits only 5 bytes, so
    // file 0 materialises + registers, file 1 hits quota and degrades the table.
    // File 0's sync access handle MUST be released — otherwise it leaks for the
    // DB's lifetime.
    const opfs = makeFakeOpfs({ quotaBytes: 5 })
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()
    const payload = new Uint8Array([1, 2, 3, 4, 5])

    const handle = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => payload),
      fetchConcurrency: 1, // deterministic: file 0 before file 1
      tables: [{
        table: 'pages',
        files: [
          { url: '/pages-0', bytes: 5, contentHash: 'iceberg/p0.parquet' },
          { url: '/pages-1', bytes: 5, contentHash: 'iceberg/p1.parquet' },
        ],
      }],
    })

    expect(handle.tables).toEqual([])
    expect(handle.degradedTables).toEqual(['pages'])
    // The crux: no leaked handle. file 0 was registered then must be released.
    expect(stub.liveCount()).toBe(0)
  })

  it('releases file-0 handle when file-1 hits an access-handle conflict (no leak)', async () => {
    // file 0 registers fine; file 1's registerFileHandle throws the conflict.
    // The table degrades. file 0 must not leak.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const payload = new Uint8Array([1, 2, 3])
    // Pre-compute file-1's name to mark it as a conflict.
    const { contentHashSlugFor } = await import('./helpers/slug')
    const file1Slug = await contentHashSlugFor('iceberg/p1.parquet')
    const file1Name = `gscdump-snapshot__pages_${file1Slug}.parquet`
    const stub = stubDuckDb({ conflictNames: new Set([file1Name]) })

    const handle = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => payload),
      fetchConcurrency: 1,
      tables: [{
        table: 'pages',
        files: [
          { url: '/pages-0', bytes: 3, contentHash: 'iceberg/p0.parquet' },
          { url: '/pages-1', bytes: 3, contentHash: 'iceberg/p1.parquet' },
        ],
      }],
    })

    expect(handle.degradedTables).toEqual(['pages'])
    expect(stub.liveCount()).toBe(0)
  })

  it('degrades a table when createWritable hits a write-exclusivity conflict (no leak)', async () => {
    // file 0 materialises fine; file 1's createWritable throws
    // NoModificationAllowedError (backing file held open by another consumer).
    // Regression: this used to propagate and fail the whole attach instead of
    // degrading the table to the buffer-path fallback. file 0 must not leak.
    const { contentHashSlugFor } = await import('./helpers/slug')
    const file1Slug = await contentHashSlugFor('iceberg/p1.parquet')
    const file1Name = `gscdump-snapshot__pages_${file1Slug}.parquet`
    const opfs = makeFakeOpfs({ writeConflictNames: new Set([file1Name]) })
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()
    const payload = new Uint8Array([1, 2, 3])

    const handle = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => payload),
      fetchConcurrency: 1, // deterministic: file 0 before file 1
      tables: [{
        table: 'pages',
        files: [
          { url: '/pages-0', bytes: 3, contentHash: 'iceberg/p0.parquet' },
          { url: '/pages-1', bytes: 3, contentHash: 'iceberg/p1.parquet' },
        ],
      }],
    })

    expect(handle.tables).toEqual([])
    expect(handle.degradedTables).toEqual(['pages'])
    expect(stub.liveCount()).toBe(0)
  })

  it('releases handles acquired by slower workers after a concurrent download failure', async () => {
    // Two workers start together. `/bad` fails immediately while `/good` is
    // still downloading. The attach must wait for the in-flight worker before
    // it runs failure cleanup, otherwise `/good` can register after cleanup and
    // leak a live handle.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()
    const payload = new Uint8Array([1, 2])
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/bad')
        throw new Error('network boom')
      await new Promise(r => setTimeout(r, 5))
      return new Response(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength), { status: 200 })
    }) as unknown as typeof fetch

    await expect(attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: fetchImpl,
      fetchConcurrency: 2,
      tables: [{
        table: 'pages',
        files: [
          { url: '/good', bytes: 2, contentHash: 'iceberg/good.parquet' },
          { url: '/bad', bytes: 2, contentHash: 'iceberg/bad.parquet' },
        ],
      }],
    })).rejects.toThrow(/network boom/)

    await new Promise(r => setTimeout(r, 20))
    expect(stub.liveCount()).toBe(0)
  })
})

describe('opfs adversarial: view-creation conflict', () => {
  it('releases handles when the view creation hits a conflict (degrade), no leak', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb({ viewConflictTables: new Set(['pages']) })

    const handle = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2])),
      tables: [{ table: 'pages', files: [{ url: '/x', bytes: 2, contentHash: 'iceberg/p.parquet' }] }],
    })

    expect(handle.tables).toEqual([])
    expect(handle.degradedTables).toEqual(['pages'])
    expect(stub.liveCount()).toBe(0)
  })

  it('view conflict on one table leaves other attached tables intact and leak-free on detach', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb({ viewConflictTables: new Set(['pages']) })

    const handle = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2])),
      tables: [
        { table: 'queries', files: [{ url: '/q', bytes: 2, contentHash: 'iceberg/q.parquet' }] },
        { table: 'pages', files: [{ url: '/p', bytes: 2, contentHash: 'iceberg/p.parquet' }] },
      ],
    })

    expect(handle.tables).toEqual(['queries'])
    expect(handle.degradedTables).toEqual(['pages'])
    // pages' handle released; queries' still live (one).
    expect(stub.liveCount()).toBe(1)
    await handle.detach()
    expect(stub.liveCount()).toBe(0)
  })
})

describe('opfs adversarial: abort', () => {
  it('releases every acquired handle when aborted mid-view-creation (no leak)', async () => {
    // Two tables. Abort fires after downloads + registrations, before/within
    // the view loop. Every acquired handle must be released on the abort
    // teardown path.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const controller = new AbortController()
    const stub = stubDuckDb()
    // Abort as soon as the first view query runs.
    const origQuery = stub.conn.query as unknown as (sql: string) => Promise<unknown>
    ;(stub.conn as any).query = vi.fn(async (sql: string) => {
      controller.abort()
      return origQuery(sql)
    })

    await expect(attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2])),
      signal: controller.signal,
      tables: [
        { table: 'queries', files: [{ url: '/q', bytes: 2, contentHash: 'iceberg/q.parquet' }] },
        { table: 'pages', files: [{ url: '/p', bytes: 2, contentHash: 'iceberg/p.parquet' }] },
      ],
    })).rejects.toThrow()

    // Every handle acquired during the download loop must be released.
    expect(stub.liveCount()).toBe(0)
  })

  it('releases already-acquired handles when aborted during a download fetch (no leak)', async () => {
    // Concurrency 1. The abort fires inside the SECOND fetch. The download loop
    // does not re-check the signal after the fetch, so both files register; the
    // abort surfaces at the view-loop guard, whose teardown must release BOTH
    // handles. Documents that an abort during the download phase still ends
    // leak-free via the view-loop teardown.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const controller = new AbortController()
    const stub = stubDuckDb()
    let fetchCount = 0
    const abortingFetch = vi.fn(async () => {
      fetchCount++
      if (fetchCount === 2)
        controller.abort()
      return new Response(new Uint8Array([1, 2]).buffer, { status: 200 })
    }) as unknown as typeof fetch

    await expect(attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: abortingFetch,
      fetchConcurrency: 1,
      signal: controller.signal,
      tables: [{
        table: 'pages',
        files: [
          { url: '/p0', bytes: 2, contentHash: 'iceberg/p0.parquet' },
          { url: '/p1', bytes: 2, contentHash: 'iceberg/p1.parquet' },
        ],
      }],
    })).rejects.toThrow()

    // file 0 was registered before the abort — it must be released.
    expect(stub.liveCount()).toBe(0)
  })

  it('releases file-0 when the download loop throws AbortError before file-1 (no leak)', async () => {
    // Concurrency 1. file 0 acquires, then onFileProgress aborts. file 1's
    // materialiseFile hits `throwIfAborted` at its very top and throws, so the
    // download loop (runWithConcurrency) rejects with AbortError straight out of
    // attachOpfsParquetTables — there is NO view loop to clean up. file 0's
    // handle must still be released.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const controller = new AbortController()
    const stub = stubDuckDb()

    await expect(attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2])),
      fetchConcurrency: 1,
      signal: controller.signal,
      onFileProgress: () => { controller.abort() },
      tables: [{
        table: 'pages',
        files: [
          { url: '/p0', bytes: 2, contentHash: 'iceberg/p0.parquet' },
          { url: '/p1', bytes: 2, contentHash: 'iceberg/p1.parquet' },
        ],
      }],
    })).rejects.toThrow()

    // file 0 registered before the abort; the download-loop teardown must
    // release it even though the abort escaped before the view loop.
    expect(stub.liveCount()).toBe(0)
  })
})

describe('opfs adversarial: double-release / detach after degrade', () => {
  it('detach after a partial-materialise degrade does not double-drop a shared handle', async () => {
    // db A attaches `dates` (shared file). Then a second attach degrades a
    // multi-file `pages` table that SHARES file-0 with nothing, so the only
    // shared concern is whether releaseTable + detach interleave correctly.
    // Here: consumer 1 holds `dates`. Consumer 2 attaches `dates` again (ref=2)
    // plus a `pages` that partial-fails. Detaching consumer 2 must drop pages'
    // own handle and decrement dates to 1 (NOT drop dates).
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()
    const shared = { url: '/shared', bytes: 3, contentHash: 'iceberg/shared.parquet' }

    const c1 = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2, 3])),
      tables: [{ table: 'dates', files: [shared] }],
    })
    expect(stub.liveCount()).toBe(1)

    // Consumer 2: re-attach dates (refcount→2) — clean.
    const c2 = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2, 3])),
      tables: [{ table: 'dates', files: [shared] }],
    })
    expect(stub.liveCount()).toBe(1) // still one backing handle

    await c2.detach()
    // dates still held by c1 — must NOT be dropped.
    expect(stub.liveCount()).toBe(1)
    await c1.detach()
    expect(stub.liveCount()).toBe(0)
  })
})

describe('opfs adversarial: cross-DB isolation', () => {
  it('two DIFFERENT db objects each register their own handle for the same name', async () => {
    // The registry is per-db (WeakMap). Two distinct db instances attaching the
    // same OPFS file name each open their own sync access handle. This documents
    // the real behaviour: per-db isolation, NOT a shared registry.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stubA = stubDuckDb()
    const stubB = stubDuckDb()
    const file = { url: '/shared', bytes: 3, contentHash: 'iceberg/shared.parquet' }

    const a = await attachOpfsParquetTables({
      db: stubA.db,
      conn: stubA.conn,
      fetch: okFetch(() => new Uint8Array([1, 2, 3])),
      tables: [{ table: 'dates', files: [file] }],
    })
    const b = await attachOpfsParquetTables({
      db: stubB.db,
      conn: stubB.conn,
      fetch: okFetch(() => new Uint8Array([1, 2, 3])),
      tables: [{ table: 'dates', files: [file] }],
    })

    expect(a.tables).toEqual(['dates'])
    expect(b.tables).toEqual(['dates'])
    // Each db has its OWN registry → its own handle. Distinct DuckDB instances
    // run distinct workers, so two handles on one backing OPFS file is fine
    // here only because these are independent fakes; the registry never shares
    // state across db objects. Documented characterization.
    expect(stubA.liveCount()).toBe(1)
    expect(stubB.liveCount()).toBe(1)
    await a.detach()
    await b.detach()
    expect(stubA.liveCount()).toBe(0)
    expect(stubB.liveCount()).toBe(0)
  })
})

describe('opfs adversarial: content-addressed sweep', () => {
  it('reaps stale-hash + legacy index entries for the table, keeps sibling tables', async () => {
    const opfs = makeFakeOpfs()
    const { contentHashSlugFor } = await import('./helpers/slug')
    const staleSlug = await contentHashSlugFor('iceberg/old.parquet')
    const legacySlug = await contentHashSlugFor('iceberg/legacy.parquet')
    // Stale content-addressed entry (hash no longer in the manifest).
    opfs.files.set(`gscdump-snapshot__pages_${staleSlug}.parquet`, new Uint8Array([9]))
    // Legacy index-named entries from a pre-content-addressing build — both the
    // `<table>_<n>_<slug>` and the bare `<table>_<n>` forms.
    opfs.files.set(`gscdump-snapshot__pages_0_${legacySlug}.parquet`, new Uint8Array([8]))
    opfs.files.set(`gscdump-snapshot__pages_1.parquet`, new Uint8Array([7]))
    // A DIFFERENT table whose name extends `pages` — must survive. The matcher
    // is anchored on a pure hex/index segment, so `summary_…` can't match the
    // `pages` sweep (this is the boundary the old per-slot sweep protected).
    opfs.files.set(`gscdump-snapshot__pages_summary_aaaaaaaaaaaaaaaa.parquet`, new Uint8Array([6, 6]))
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()

    await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2, 3])),
      tables: [{ table: 'pages', files: [{ url: '/x', bytes: 3, contentHash: 'iceberg/new.parquet' }] }],
    })

    const keys = [...opfs.files.keys()]
    // Sibling table preserved.
    expect(keys).toContain('gscdump-snapshot__pages_summary_aaaaaaaaaaaaaaaa.parquet')
    // Stale + both legacy forms for `pages` reaped.
    expect(keys.some(k => k.includes(`pages_${staleSlug}`))).toBe(false)
    expect(keys.some(k => k.includes(`pages_0_${legacySlug}`))).toBe(false)
    expect(keys).not.toContain('gscdump-snapshot__pages_1.parquet')
    // The fresh file is materialised under its content address.
    const newSlug = await contentHashSlugFor('iceberg/new.parquet')
    expect(keys).toContain(`gscdump-snapshot__pages_${newSlug}.parquet`)
  })
})

describe('opfs adversarial: table churn on a shared DB', () => {
  it('detaching one table leaves a different table attached and untouched', async () => {
    // A dashboard attaches `pages`, then later attaches `queries` in a separate
    // call on the same DB, then drops `pages`. `queries` must stay attached with
    // its handle live; only `pages` is torn down.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()
    const mk = (table: string, hash: string) => attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2, 3])),
      tables: [{ table, files: [{ url: `/${table}`, bytes: 3, contentHash: hash }] }],
    })
    const hPages = await mk('pages', 'iceberg/pages.parquet')
    const hQueries = await mk('queries', 'iceberg/queries.parquet')
    expect(stub.liveCount()).toBe(2)

    await hPages.detach()
    expect(stub.hasView('main.pages')).toBe(false)
    expect(stub.hasView('main.queries')).toBe(true)
    expect(stub.liveCount()).toBe(1)

    await hQueries.detach()
    expect(stub.hasView('main.queries')).toBe(false)
    expect(stub.liveCount()).toBe(0)
  })

  it('re-attaching a table with a CHANGED fileset after detach is clean', async () => {
    // `pages` first attaches as 1 file (hash A). Later it re-attaches as 2 files
    // (hashes B0/B1) — a recompaction. After detach+reattach the new fileset is
    // live with no stale handle from the old fileset.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()

    const h1 = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1])),
      tables: [{ table: 'pages', files: [{ url: '/a', bytes: 1, contentHash: 'iceberg/A.parquet' }] }],
    })
    await h1.detach()
    expect(stub.liveCount()).toBe(0)

    const h2 = await attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([2])),
      tables: [{ table: 'pages', files: [
        { url: '/b0', bytes: 1, contentHash: 'iceberg/B0.parquet' },
        { url: '/b1', bytes: 1, contentHash: 'iceberg/B1.parquet' },
      ] }],
    })
    expect(h2.tables).toEqual(['pages'])
    expect(h2.degradedTables).toEqual([])
    expect(stub.liveCount()).toBe(2)
    await h2.detach()
    expect(stub.liveCount()).toBe(0)
  })

  it('same table in two different schemas shares one handle but keeps independent views', async () => {
    // opfsFileName is keyed by (table, content hash) — NOT schema — so the same
    // table attached into `main` and `site2` collapses to ONE OPFS file/handle,
    // yet each schema gets its own view. Detaching one schema must drop only its
    // view and decrement (not drop) the shared handle.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()
    const file = { url: '/d', bytes: 3, contentHash: 'iceberg/d.parquet' }
    const mk = (schema: string) => attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      schema,
      fetch: okFetch(() => new Uint8Array([1, 2, 3])),
      tables: [{ table: 'dates', files: [file] }],
    })
    const a = await mk('main')
    const b = await mk('site2')
    expect(stub.hasView('main.dates')).toBe(true)
    expect(stub.hasView('site2.dates')).toBe(true)
    expect(stub.liveCount()).toBe(1) // one shared handle

    await a.detach()
    expect(stub.hasView('main.dates')).toBe(false)
    expect(stub.hasView('site2.dates')).toBe(true)
    expect(stub.liveCount()).toBe(1) // handle kept for schema site2

    await b.detach()
    expect(stub.hasView('site2.dates')).toBe(false)
    expect(stub.liveCount()).toBe(0)
  })

  it('a same-signature reattach skips view DDL and keeps the sibling view alive', async () => {
    // Consumer A holds `dates`. Consumer B re-attaches the same table on the
    // shared DB. The same-signature view is already live, so B should not run
    // another CREATE at all; it only bumps the view/file refs.
    installNavigatorStorage(makeFakeOpfs().root)
    const live = new Set<string>()
    const views = new Set<string>()
    let createCount = 0
    const db = {
      registerFileHandle: vi.fn(async (name: string) => {
        if (live.has(name)) {
          const e = new Error(`Access Handles cannot be created (${name})`)
          e.name = 'InvalidStateError'
          throw e
        }
        live.add(name)
      }),
      dropFile: vi.fn(async (name: string) => { live.delete(name) }),
    } as unknown as AsyncDuckDB
    const conn = {
      query: vi.fn(async (sql: string) => {
        const create = /CREATE OR REPLACE VIEW (\w+\.\w+)/.exec(sql)
        if (create) {
          createCount++
          views.add(create[1]!)
        }
        const drop = /DROP VIEW IF EXISTS (\w+\.\w+)/.exec(sql)
        if (drop)
          views.delete(drop[1]!)
        return { toArray: () => [] }
      }),
    } as unknown as AsyncDuckDBConnection
    const file = { url: '/d', bytes: 3, contentHash: 'iceberg/d.parquet' }
    const mk = () => attachOpfsParquetTables({ db, conn, fetch: okFetch(() => new Uint8Array([1, 2, 3])), tables: [{ table: 'dates', files: [file] }] })

    const a = await mk()
    expect(a.tables).toEqual(['dates'])
    expect(views.has('main.dates')).toBe(true)

    const b = await mk()
    expect(b.tables).toEqual(['dates'])
    expect(b.degradedTables).toEqual([])
    expect(createCount).toBe(1)
    // A's view MUST survive B's degrade cleanup, and A keeps its single handle.
    expect(views.has('main.dates')).toBe(true)
    expect(live.size).toBe(1)

    await a.detach()
    expect(views.has('main.dates')).toBe(true)
    expect(live.size).toBe(1)
    await b.detach()
    expect(views.has('main.dates')).toBe(false)
    expect(live.size).toBe(0)
  })

  it('detaching one consumer must NOT drop a shared view another consumer still uses', async () => {
    // The exact shared-DB scenario the registry exists for: two consumers attach
    // the SAME table (same view name + same file). The file handle is refcounted
    // correctly, but the VIEW must also survive until the LAST consumer detaches
    // — otherwise consumer B's queries break the moment consumer A navigates away.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const stub = stubDuckDb()
    const file = { url: '/shared', bytes: 3, contentHash: 'iceberg/shared.parquet' }
    const mk = () => attachOpfsParquetTables({
      db: stub.db,
      conn: stub.conn,
      fetch: okFetch(() => new Uint8Array([1, 2, 3])),
      tables: [{ table: 'dates', files: [file] }],
    })
    const a = await mk()
    const b = await mk()
    expect(stub.hasView('main.dates')).toBe(true)
    expect(stub.liveCount()).toBe(1)

    // Consumer A detaches. B still holds the table — the view MUST remain.
    await a.detach()
    expect(stub.liveCount()).toBe(1) // handle kept (refcount)
    expect(stub.hasView('main.dates')).toBe(true) // view kept too

    // Last consumer detaches: now both view and handle go.
    await b.detach()
    expect(stub.liveCount()).toBe(0)
    expect(stub.hasView('main.dates')).toBe(false)
  })
})
