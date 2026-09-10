/**
 * Unit tests for the OPFS attach module.
 *
 * Verifies the content-addressed cache (filename embeds `contentHash` so a
 * cache hit is filename-existence + size match — no SHA recomputation), legacy
 * entry sweep on re-attach, quota degradation, and view tear-down. The REAL
 * OPFS round-trip (`navigator.storage.getDirectory` + DuckDB-WASM
 * `BROWSER_FSACCESS`) needs a browser and is covered by
 * `poc/iceberg/browser/index.html`.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachOpfsParquetTables, OpfsQuotaExceededError } from '../src/opfs'

// ── in-memory OPFS fake ─────────────────────────────────────────────────────

function makeFakeOpfs(opts: { quotaBytes?: number, writeConflict?: Set<string> } = {}) {
  const files = new Map<string, Uint8Array>()
  let used = 0
  const quota = opts.quotaBytes ?? Infinity
  const writeConflict = opts.writeConflict ?? new Set<string>()

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
        // Model the OPFS write-exclusivity conflict (another tab holds the sync
        // access handle): createWritable throws NoModificationAllowedError.
        if (writeConflict.has(name)) {
          const err = new Error(`modifications are not allowed (${name})`)
          err.name = 'NoModificationAllowedError'
          throw err
        }
        let pending: Uint8Array = new Uint8Array()
        return {
          async write(data: ArrayBuffer | Uint8Array) {
            const chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
            const combined = new Uint8Array(pending.byteLength + chunk.byteLength)
            combined.set(pending)
            combined.set(chunk, pending.byteLength)
            pending = combined
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

function stubDuckDb(opts: { live?: Set<string> } = {}): {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  registerFileHandle: ReturnType<typeof vi.fn>
  registerFileBuffer: ReturnType<typeof vi.fn>
  dropFile: ReturnType<typeof vi.fn>
  bufferNames: string[]
  viewSql: string[]
} {
  // Model OPFS exclusivity: a name allows only one live sync access handle, so
  // a second registerFileHandle on a live name throws the conflict DuckDB would.
  // `live` can be SHARED across two stub DBs to model cross-tab exclusivity
  // (OPFS handles are exclusive per origin, not per AsyncDuckDB instance).
  const live = opts.live ?? new Set<string>()
  const registerFileHandle = vi.fn(async (name: string) => {
    if (live.has(name)) {
      const err = new Error(`Access Handles cannot be created (${name})`)
      err.name = 'InvalidStateError'
      throw err
    }
    live.add(name)
  })
  // In-memory buffer registration (the contention-recovery fallback). No
  // exclusivity — buffers live in WASM linear memory, not OPFS.
  const bufferNames: string[] = []
  const registerFileBuffer = vi.fn(async (name: string) => {
    bufferNames.push(name)
  })
  const dropFile = vi.fn(async (name: string) => {
    live.delete(name)
  })
  const viewSql: string[] = []
  const query = vi.fn(async (sql: string) => {
    viewSql.push(sql)
    return { toArray: () => [] }
  })
  return {
    db: { registerFileHandle, registerFileBuffer, dropFile } as unknown as AsyncDuckDB,
    conn: { query } as unknown as AsyncDuckDBConnection,
    registerFileHandle,
    registerFileBuffer,
    dropFile,
    bufferNames,
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
    expect([...opfs.files.keys()][0]).toBe(`gscdump-snapshot__pages_${slug}.parquet`)
  })

  it('streams response chunks into OPFS without materialising an ArrayBuffer', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn } = stubDuckDb()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4, 5]))
        controller.close()
      },
    }), { status: 200 })
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await attachOpfsParquetTables({
      db,
      conn,
      fetch: fetchImpl,
      tables: [{
        table: 'pages',
        files: [{ url: '/streamed', bytes: 5, contentHash: 'iceberg/streamed.parquet' }],
      }],
    })

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect([...opfs.files.values()][0]).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it('rejects downloaded files whose byte length does not match the manifest', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, registerFileHandle } = stubDuckDb()
    const payload = new Uint8Array([1, 2, 3])

    await expect(attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{
        table: 'pages',
        files: [{ url: '/api/r2-data/pages-0.parquet', bytes: 5, contentHash: 'iceberg/abc.parquet' }],
      }],
    })).rejects.toThrow(/byte length mismatch/)

    expect(registerFileHandle).not.toHaveBeenCalled()
    expect(opfs.files.size).toBe(0)
  })

  it('rejects invalid SQL identifiers before building DuckDB view SQL', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn } = stubDuckDb()

    await expect(attachOpfsParquetTables({
      db,
      conn,
      schema: 'bad-schema',
      fetch: okFetch(new Uint8Array([1])),
      tables: [{ table: 'dates', files: [{ url: '/x', bytes: 1, contentHash: 'iceberg/x.parquet' }] }],
    })).rejects.toThrow(/invalid schema identifier/)

    await expect(attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([1])),
      tables: [{ table: 'bad-table', files: [{ url: '/x', bytes: 1, contentHash: 'iceberg/x.parquet' }] }],
    })).rejects.toThrow(/invalid table identifier/)
  })

  it('serves a cache hit (filename + size) without re-downloading', async () => {
    const opfs = makeFakeOpfs()
    const payload = new Uint8Array([9, 9, 9])
    const slug = await expectedSlug('iceberg/queries-0.parquet')
    opfs.files.set(`gscdump-snapshot__queries_${slug}.parquet`, payload)
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

  it('reports attach timing phases and per-file durations', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn } = stubDuckDb()
    const payload = new Uint8Array([1, 2, 3])
    const timings: Array<{ stage: string, durationMs: number, table?: string, outcome?: string }> = []
    const progress: Array<{ materialiseMs?: number, registerMs?: number, totalMs?: number }> = []

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'dates', files: [{ url: '/dates-0', bytes: 3, contentHash: 'iceberg/timing.parquet' }] }],
      onTiming: info => timings.push(info),
      onFileProgress: info => progress.push(info),
    })

    expect(handle.tables).toEqual(['dates'])
    expect(progress).toHaveLength(1)
    expect(progress[0]!.materialiseMs).toEqual(expect.any(Number))
    expect(progress[0]!.registerMs).toEqual(expect.any(Number))
    expect(progress[0]!.totalMs).toEqual(expect.any(Number))

    const stages = timings.map(t => t.stage)
    expect(stages).toEqual(expect.arrayContaining([
      'persist',
      'root',
      'plan',
      'duckdb-import',
      'sweep',
      'materialise',
      'register',
      'downloads',
      'view',
      'total',
    ]))
    expect(timings.every(t => Number.isFinite(t.durationMs) && t.durationMs >= 0)).toBe(true)
    expect(timings.find(t => t.stage === 'materialise')).toMatchObject({ table: 'dates', outcome: 'downloaded' })
    expect(timings.find(t => t.stage === 'register')).toMatchObject({ table: 'dates', outcome: 'downloaded' })
    expect(timings.find(t => t.stage === 'view')).toMatchObject({ table: 'dates' })
  })

  it('re-downloads when the content hash changes (new filename)', async () => {
    const opfs = makeFakeOpfs()
    // Old snapshot's cached file under the OLD content hash.
    const oldSlug = await expectedSlug('iceberg/old.parquet')
    opfs.files.set(`gscdump-snapshot__pages_${oldSlug}.parquet`, new Uint8Array([0, 0, 0]))
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
    // A different requested hash does not prove that the old file is obsolete.
    expect(opfs.files.get(`gscdump-snapshot__pages_${oldSlug}.parquet`)).toEqual(new Uint8Array([0, 0, 0]))
    const newSlug = await expectedSlug('iceberg/new.parquet')
    expect(opfs.files.get(`gscdump-snapshot__pages_${newSlug}.parquet`)).toEqual(fresh)
  })

  it('re-downloads when a cached file has the wrong byte size (partial write)', async () => {
    const opfs = makeFakeOpfs()
    const slug = await expectedSlug('iceberg/pages-0.parquet')
    // Wrong size — looks like a torn write.
    opfs.files.set(`gscdump-snapshot__pages_${slug}.parquet`, new Uint8Array([0]))
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

  it('detach drops the views AND releases the OPFS sync access handle', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, dropFile, viewSql } = stubDuckDb()
    const payload = new Uint8Array([4, 2])

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'pages', files: [{ url: '/x', bytes: 2, contentHash: 'iceberg/p.parquet' }] }],
    })
    await handle.detach()
    expect(viewSql.some(s => s.includes('DROP VIEW IF EXISTS main.pages'))).toBe(true)
    // Regression: detach must release the sync access handle, not leak it for
    // the DB's lifetime. Exactly one file was registered, so exactly one drop.
    expect(dropFile).toHaveBeenCalledOnce()
    // idempotent
    await expect(handle.detach()).resolves.toBeUndefined()
    expect(dropFile).toHaveBeenCalledOnce()
  })

  it('two consumers sharing one DB attach the same file without an OPFS conflict', async () => {
    // The crux of the flagged root issue: the home fanout and the per-site
    // analyzer share one DB via `sharedGscDuckDBWasm` and attach the same OPFS
    // parquet. The registry dedups the registration (one sync access handle)
    // and only releases it once BOTH consumers detach.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, registerFileHandle, dropFile } = stubDuckDb()
    const payload = new Uint8Array([1, 2, 3])
    const file = { url: '/shared', bytes: 3, contentHash: 'iceberg/shared.parquet' }

    const first = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'dates', files: [file] }],
    })
    const second = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'dates', files: [file] }],
    })

    expect(first.tables).toEqual(['dates'])
    expect(second.tables).toEqual(['dates'])
    expect(second.degradedTables).toEqual([])
    // One backing file → exactly one sync access handle registered.
    expect(registerFileHandle).toHaveBeenCalledOnce()

    // First consumer detaches: the second still reads through it, keep it open.
    await first.detach()
    expect(dropFile).not.toHaveBeenCalled()
    // Last consumer detaches: now release.
    await second.detach()
    expect(dropFile).toHaveBeenCalledOnce()
  })

  it('reuses an already-live identical view without recreating DDL', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, registerFileHandle, viewSql } = stubDuckDb()
    const payload = new Uint8Array([1, 2, 3])
    const file = { url: '/shared', bytes: 3, contentHash: 'iceberg/shared-view.parquet' }

    const first = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'dates', files: [file] }],
    })
    const second = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'dates', files: [file] }],
    })

    expect(registerFileHandle).toHaveBeenCalledOnce()
    expect(viewSql.filter(sql => sql.includes('CREATE OR REPLACE VIEW main.dates'))).toHaveLength(1)

    await first.detach()
    expect(viewSql.filter(sql => sql.includes('DROP VIEW IF EXISTS main.dates'))).toHaveLength(0)
    await second.detach()
    expect(viewSql.filter(sql => sql.includes('DROP VIEW IF EXISTS main.dates'))).toHaveLength(1)
  })

  it('refcounts recovered buffers and view across sibling consumers', async () => {
    const opfs = makeFakeOpfs()
    const payload = new Uint8Array([1, 2, 3])
    const slug = await expectedSlug('iceberg/recovered.parquet')
    const opfsName = `gscdump-snapshot__dates_${slug}.parquet`
    opfs.files.set(opfsName, payload)
    installNavigatorStorage(opfs.root)
    const live = new Set<string>([opfsName])
    const { db, conn, registerFileBuffer, dropFile, bufferNames, viewSql } = stubDuckDb({ live })
    const file = { url: '/shared', bytes: 3, contentHash: 'iceberg/recovered.parquet' }

    const first = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'dates', files: [file] }],
    })
    const second = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(payload),
      tables: [{ table: 'dates', files: [file] }],
    })

    expect(first.tables).toEqual(['dates'])
    expect(second.tables).toEqual(['dates'])
    expect(registerFileBuffer).toHaveBeenCalledOnce()
    expect(bufferNames).toEqual([`gscdump-recover__dates_${slug}.parquet`])
    expect(viewSql.filter(sql => sql.includes('CREATE OR REPLACE VIEW main.dates'))).toHaveLength(1)

    await first.detach()
    expect(viewSql.filter(sql => sql.includes('DROP VIEW IF EXISTS main.dates'))).toHaveLength(0)
    expect(dropFile).not.toHaveBeenCalledWith(bufferNames[0])

    await second.detach()
    expect(viewSql.filter(sql => sql.includes('DROP VIEW IF EXISTS main.dates'))).toHaveLength(1)
    expect(dropFile).toHaveBeenCalledWith(bufferNames[0])
  })

  it('rejects replacing a live view with a different fileset', async () => {
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, dropFile, viewSql } = stubDuckDb()

    const first = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([1, 2, 3])),
      tables: [{ table: 'dates', files: [{ url: '/a', bytes: 3, contentHash: 'iceberg/a.parquet' }] }],
    })

    await expect(attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([4, 5, 6])),
      tables: [{ table: 'dates', files: [{ url: '/b', bytes: 3, contentHash: 'iceberg/b.parquet' }] }],
    })).rejects.toThrow(/different fileset/)

    expect(viewSql.filter(sql => sql.includes('CREATE OR REPLACE VIEW main.dates'))).toHaveLength(1)
    expect(viewSql.filter(sql => sql.includes('DROP VIEW IF EXISTS main.dates'))).toHaveLength(0)

    await first.detach()
    expect(viewSql.filter(sql => sql.includes('DROP VIEW IF EXISTS main.dates'))).toHaveLength(1)
    expect(dropFile).toHaveBeenCalled()
  })

  it('two CONCURRENT attaches of the same file on one DB dedup to a single handle', async () => {
    // Home fanout + per-site analyzer can fire attachOpfsParquetTables
    // concurrently on the shared DB, racing two acquire(sameName) calls. The
    // per-name registration serialisation must collapse that to ONE
    // registerFileHandle — a second would hit the OPFS exclusivity error
    // modelled by stubDuckDb and degrade the table.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, registerFileHandle, dropFile } = stubDuckDb()
    const file = { url: '/shared', bytes: 3, contentHash: 'iceberg/shared.parquet' }
    const mk = () => attachOpfsParquetTables({ db, conn, fetch: okFetch(new Uint8Array([1, 2, 3])), tables: [{ table: 'dates', files: [file] }] })

    const [first, second] = await Promise.all([mk(), mk()])

    expect(first.tables).toEqual(['dates'])
    expect(second.tables).toEqual(['dates'])
    expect(first.degradedTables).toEqual([])
    expect(second.degradedTables).toEqual([])
    expect(registerFileHandle).toHaveBeenCalledOnce()

    await first.detach()
    expect(dropFile).not.toHaveBeenCalled()
    await second.detach()
    expect(dropFile).toHaveBeenCalledOnce()
  })

  it('overlay view keeps the served lake scan pushdown-friendly', async () => {
    // The overlay view dedups the recent tail against the lake via an anti-join.
    // Keep the served-row read streaming so outer filters/projections reach
    // Parquet. The second lake read supplies only dates for overlay dedup.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const { db, conn, viewSql } = stubDuckDb()

    await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([1, 2, 3])),
      tables: [{
        table: 'pages',
        files: [
          { url: '/lake-0', bytes: 3, contentHash: 'iceberg/lake-0.parquet' },
          { url: '/lake-1', bytes: 3, contentHash: 'iceberg/lake-1.parquet' },
        ],
        overlay: { url: '/overlay', bytes: 3, contentHash: 'iceberg/overlay.parquet' },
      }],
    })

    const sql = viewSql.find(s => s.includes('CREATE OR REPLACE VIEW main.pages'))
    expect(sql).toBeDefined()
    // Served lake + overlay + date-only anti-join lake scan.
    expect((sql!.match(/read_parquet\(/g) ?? []).length).toBe(3)
    expect(sql).not.toMatch(/MATERIALIZED/i)
    // Anti-join dedup is still intact: overlay only fills days the lake lacks.
    expect(sql).toMatch(/UNION ALL BY NAME/i)
    expect(sql).toMatch(/NOT IN \(SELECT DISTINCT date FROM/i)
  })

  it('withDb wraps only DB mutations — downloads run outside the lock', async () => {
    // Consumers sharing one AsyncDuckDB pass their global attach mutex as
    // `withDb`. ONLY the WASM-FS / catalog mutations (registerFileHandle,
    // CREATE VIEW) may run under it; the parquet downloads must stay outside
    // so two tables' downloads overlap instead of serialising end-to-end
    // behind the lock (the pre-fix behaviour when callers wrapped the whole
    // attach call).
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)

    let lockDepth = 0
    const withDb = async <T>(fn: () => Promise<T>): Promise<T> => {
      lockDepth++
      try {
        return await fn()
      }
      finally {
        lockDepth--
      }
    }

    const lockDepthAtRegister: number[] = []
    const lockDepthAtViewSql: number[] = []
    const lockDepthAtFetch: number[] = []
    const db = {
      registerFileHandle: vi.fn(async () => {
        lockDepthAtRegister.push(lockDepth)
      }),
      dropFile: vi.fn(async () => {}),
    } as unknown as AsyncDuckDB
    const conn = {
      query: vi.fn(async () => {
        lockDepthAtViewSql.push(lockDepth)
        return { toArray: () => [] }
      }),
    } as unknown as AsyncDuckDBConnection
    const payload = new Uint8Array([1, 2, 3])
    const fetchImpl = vi.fn(async () => {
      lockDepthAtFetch.push(lockDepth)
      return new Response(payload.buffer.slice(0), { status: 200 })
    }) as unknown as typeof fetch

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: fetchImpl,
      withDb,
      tables: [
        {
          table: 'pages',
          files: [{ url: '/lake-0', bytes: 3, contentHash: 'iceberg/p-0.parquet' }],
        },
        {
          table: 'queries',
          files: [{ url: '/lake-1', bytes: 3, contentHash: 'iceberg/q-0.parquet' }],
          overlay: { url: '/overlay', bytes: 3, contentHash: 'iceberg/q-overlay.parquet' },
        },
      ],
    })

    expect(handle.tables.sort()).toEqual(['pages', 'queries'])
    expect(lockDepthAtFetch.length).toBe(3)
    expect(lockDepthAtFetch.every(d => d === 0)).toBe(true)
    expect(lockDepthAtRegister.length).toBe(3)
    expect(lockDepthAtRegister.every(d => d > 0)).toBe(true)
    expect(lockDepthAtViewSql.length).toBe(2)
    expect(lockDepthAtViewSql.every(d => d > 0)).toBe(true)
  })

  it('recovers a cross-tab contended table from the shared OPFS cache (no re-download)', async () => {
    // Two tabs = two AsyncDuckDB instances sharing ONE origin's OPFS. Tab A
    // attaches the file (writes it to OPFS, holds the exclusive sync handle).
    // Tab B attaches the SAME file: its registerFileHandle hits the exclusivity
    // conflict → the table degrades `contention` → in-engine recovery reads the
    // already-cached bytes via the lock-free getFile and registers them as a
    // buffer. B attaches cleanly with NO HTTP re-download.
    const opfs = makeFakeOpfs()
    installNavigatorStorage(opfs.root)
    const live = new Set<string>() // shared exclusivity across both "tabs"
    const a = stubDuckDb({ live })
    const b = stubDuckDb({ live })
    const file = { url: '/shared', bytes: 3, contentHash: 'iceberg/shared.parquet' }
    const aFetch = okFetch(new Uint8Array([1, 2, 3]))
    const bFetch = okFetch(new Uint8Array([1, 2, 3]))

    const first = await attachOpfsParquetTables({ db: a.db, conn: a.conn, fetch: aFetch, tables: [{ table: 'dates', files: [file] }] })
    const second = await attachOpfsParquetTables({ db: b.db, conn: b.conn, fetch: bFetch, tables: [{ table: 'dates', files: [file] }] })

    expect(first.tables).toEqual(['dates'])
    // B recovered: the table is attached, NOT degraded.
    expect(second.tables).toEqual(['dates'])
    expect(second.degradedTables).toEqual([])
    // Recovery read from the shared cache, not the network.
    expect(bFetch).not.toHaveBeenCalled()
    // B registered a buffer (the recovery path) + created its view.
    expect(b.registerFileBuffer).toHaveBeenCalledOnce()
    const recoverSlug = await expectedSlug('iceberg/shared.parquet')
    expect(b.bufferNames[0]).toBe(`gscdump-recover__dates_${recoverSlug}.parquet`)
    expect(b.viewSql.some(s => s.includes('CREATE OR REPLACE VIEW main.dates'))).toBe(true)

    // Detach drops B's recovery buffer + view.
    await second.detach()
    expect(b.dropFile).toHaveBeenCalledWith(b.bufferNames[0])
    expect(b.viewSql.some(s => s.includes('DROP VIEW IF EXISTS main.dates'))).toBe(true)
  })

  it('recovery falls back to HTTP when the contended file is not in the cache', async () => {
    // Write-exclusivity conflict (createWritable throws): our own write never
    // lands, so the file is absent from OPFS. Recovery's getFile misses → it
    // fetches over HTTP, registers the buffer, and the table still attaches.
    const slug = await expectedSlug('iceberg/miss.parquet')
    const name = `gscdump-snapshot__queries_${slug}.parquet`
    const opfs = makeFakeOpfs({ writeConflict: new Set([name]) })
    installNavigatorStorage(opfs.root)
    const { db, conn, registerFileBuffer, bufferNames } = stubDuckDb()
    const fetchSpy = okFetch(new Uint8Array([7, 7, 7]))

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: fetchSpy,
      tables: [{ table: 'queries', files: [{ url: '/x', bytes: 3, contentHash: 'iceberg/miss.parquet' }] }],
    })

    expect(handle.tables).toEqual(['queries'])
    expect(handle.degradedTables).toEqual([])
    expect(registerFileBuffer).toHaveBeenCalledOnce()
    const recoverSlug = await expectedSlug('iceberg/miss.parquet')
    expect(bufferNames[0]).toBe(`gscdump-recover__queries_${recoverSlug}.parquet`)
    // At least one HTTP read happened (the recovery fetch).
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('does NOT buffer-recover a quota-degraded table (OOM-safe)', async () => {
    const opfs = makeFakeOpfs({ quotaBytes: 0 })
    installNavigatorStorage(opfs.root)
    const { db, conn, registerFileBuffer } = stubDuckDb()

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([1, 2, 3])),
      tables: [{ table: 'pages', files: [{ url: '/x', bytes: 3, contentHash: 'iceberg/q.parquet' }] }],
    })

    expect(handle.tables).toEqual([])
    expect(handle.degradedTables).toEqual(['pages'])
    // Quota degradations are never buffer-recovered.
    expect(registerFileBuffer).not.toHaveBeenCalled()
  })

  it('recoverContention:false leaves a contended table degraded', async () => {
    const slug = await expectedSlug('iceberg/shared.parquet')
    const name = `gscdump-snapshot__dates_${slug}.parquet`
    // Pre-seed the exclusivity set so the single attach hits the conflict.
    const live = new Set<string>([name])
    const opfs = makeFakeOpfs()
    opfs.files.set(name, new Uint8Array([1, 2, 3]))
    installNavigatorStorage(opfs.root)
    const { db, conn, registerFileBuffer } = stubDuckDb({ live })

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([1, 2, 3])),
      recoverContention: false,
      tables: [{ table: 'dates', files: [{ url: '/shared', bytes: 3, contentHash: 'iceberg/shared.parquet' }] }],
    })

    expect(handle.tables).toEqual([])
    expect(handle.degradedTables).toEqual(['dates'])
    expect(registerFileBuffer).not.toHaveBeenCalled()
  })
})

describe('opfsQuotaExceededError', () => {
  it('carries the degraded table list', () => {
    const err = new OpfsQuotaExceededError('full', ['page_queries'])
    expect(err.name).toBe('OpfsQuotaExceededError')
    expect(err.degradedTables).toEqual(['page_queries'])
  })
})
