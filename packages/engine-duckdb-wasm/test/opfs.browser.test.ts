/**
 * OPFS attach lifecycle against a REAL browser Origin Private File System.
 *
 * The node `opfs.test.ts` stubs `navigator.storage` and `registerFileHandle`,
 * so it can only *model* the sync-access-handle exclusivity rule. This suite
 * runs in real chromium (Playwright) and reproduces the actual platform
 * primitive.
 *
 * OPFS `createSyncAccessHandle()` is Worker-only — which is exactly where
 * DuckDB-WASM runs it (its `BROWSER_FSACCESS` reads happen in the DuckDB
 * worker). So the `db` stub here transfers the `FileSystemFileHandle` to a real
 * Web Worker and opens the sync access handle THERE, faithfully reproducing the
 * one-handle-per-file exclusivity. This is the end-to-end proof that the
 * reference-counted registry both prevents that conflict (dedup) and releases
 * handles on detach (no leak).
 *
 * Run with `pnpm --filter @gscdump/engine-duckdb-wasm test:browser`.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { afterEach, describe, expect, it } from 'vitest'
import { attachOpfsParquetTables, clearOpfsSnapshotCache } from '../src/opfs'

// Worker that owns OPFS sync access handles, keyed by name. Opening a second
// handle for a live name throws the real OPFS exclusivity error, which the
// worker reports back so the main thread can react exactly as DuckDB would.
const WORKER_SRC = `
const handles = new Map()
self.onmessage = async (e) => {
  const { id, type, name, handle } = e.data
  try {
    if (type === 'open') {
      const h = await handle.createSyncAccessHandle()
      handles.set(name, h)
      self.postMessage({ id, ok: true })
    } else if (type === 'close') {
      handles.get(name)?.close()
      handles.delete(name)
      self.postMessage({ id, ok: true })
    } else if (type === 'count') {
      self.postMessage({ id, ok: true, count: handles.size })
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) })
  }
}
`

function makeHandleWorker() {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
  const worker = new Worker(url)
  let seq = 0
  const pending = new Map<number, (r: { ok: boolean, error?: string, count?: number }) => void>()
  worker.onmessage = (e: MessageEvent) => {
    const { id, ...rest } = e.data
    pending.get(id)?.(rest)
    pending.delete(id)
  }
  function call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<{ ok: boolean, error?: string, count?: number }> {
    const id = seq++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      worker.postMessage({ id, ...msg }, transfer)
    })
  }
  return {
    async open(name: string, handle: FileSystemFileHandle) {
      const r = await call({ type: 'open', name, handle })
      if (!r.ok)
        throw new Error(r.error)
    },
    async close(name: string) {
      await call({ type: 'close', name })
    },
    async count(): Promise<number> {
      return (await call({ type: 'count' })).count ?? 0
    },
    dispose() {
      worker.terminate()
      URL.revokeObjectURL(url)
    },
  }
}

/**
 * A `db` whose `registerFileHandle` acquires a REAL OPFS sync access handle in
 * a worker (as DuckDB's `BROWSER_FSACCESS` does) and whose `dropFile` releases
 * it. The worker enforces genuine one-handle-per-file exclusivity.
 */
function makeRealHandleDb(hw: ReturnType<typeof makeHandleWorker>) {
  const queries: string[] = []
  const db = {
    async registerFileHandle(name: string, handle: FileSystemFileHandle) {
      await hw.open(name, handle)
    },
    async dropFile(name: string) {
      await hw.close(name)
    },
  } as unknown as AsyncDuckDB
  const conn = {
    async query(sql: string) {
      queries.push(sql)
      return { toArray: () => [] }
    },
  } as unknown as AsyncDuckDBConnection
  return { db, conn, queries }
}

function okFetch(payload: Uint8Array): typeof fetch {
  return (async () => new Response(payload.slice().buffer, { status: 200 })) as unknown as typeof fetch
}

let activeWorker: ReturnType<typeof makeHandleWorker> | undefined

afterEach(async () => {
  activeWorker?.dispose()
  activeWorker = undefined
  await clearOpfsSnapshotCache()
})

describe('opfs attach against real browser OPFS', () => {
  it('the platform really forbids a second sync access handle on one file', async () => {
    // Establishes the invariant the whole registry rewrite is premised on,
    // against the real browser. createSyncAccessHandle is Worker-only, so the
    // probe runs inside the handle worker too.
    const hw = makeHandleWorker()
    activeWorker = hw
    const root = await navigator.storage.getDirectory()
    const fh = await root.getFileHandle('exclusivity-probe.bin', { create: true })
    await hw.open('probe', fh)
    // A second open of the same backing file must throw the OPFS conflict.
    await expect(hw.open('probe-again', fh)).rejects.toThrow()
    await hw.close('probe')
    await root.removeEntry('exclusivity-probe.bin')
  })

  it('characterization: real OPFS tolerates concurrent createWritable (materialise race is safe)', async () => {
    // The download path opens a writable per file. Two concurrent attaches of
    // the same COLD file would both reach createWritable. Chromium does NOT
    // throw on the second open — so the materialise race needs no extra
    // coalescing: both write identical bytes (content-addressed by hash), the
    // size check passes, and the registry serialises the single registration.
    const root = await navigator.storage.getDirectory()
    const fh = await root.getFileHandle('concurrent-writable-probe.bin', { create: true })
    const w1 = await fh.createWritable()
    let secondThrew = false
    try {
      const w2 = await fh.createWritable()
      await w2.close()
    }
    catch {
      secondThrew = true
    }
    await w1.close()
    await root.removeEntry('concurrent-writable-probe.bin')
    expect(secondThrew).toBe(false)
  })

  it('two concurrent COLD attaches of the same file both yield correct content + one handle', async () => {
    // End-to-end materialise race: same file, cold cache, slow fetch so both
    // attaches reach the download+write concurrently. Both must succeed with one
    // shared handle and the file must hold the correct bytes.
    const hw = makeHandleWorker()
    activeWorker = hw
    const { db, conn } = makeRealHandleDb(hw)
    const payload = new Uint8Array([3, 1, 4, 1, 5, 9])
    const slowFetch = (async () => {
      await new Promise(r => setTimeout(r, 20))
      return new Response(payload.slice().buffer, { status: 200 })
    }) as unknown as typeof fetch
    const file = { url: '/race', bytes: 6, contentHash: 'iceberg/race.parquet' }
    const mk = () => attachOpfsParquetTables({ db, conn, fetch: slowFetch, tables: [{ table: 'pages', files: [file] }] })

    const [a, b] = await Promise.all([mk(), mk()])
    expect(a.tables).toEqual(['pages'])
    expect(b.tables).toEqual(['pages'])
    expect(a.degradedTables).toEqual([])
    expect(b.degradedTables).toEqual([])
    expect(await hw.count()).toBe(1)

    // The materialised OPFS file holds the correct bytes.
    const root = await navigator.storage.getDirectory()
    let name: string | undefined
    for await (const k of (root as any).keys()) {
      if (k.startsWith('gscdump-snapshot__pages_'))
        name = k
    }
    expect(name).toBeDefined()
    const f = await (await root.getFileHandle(name!)).getFile()
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(payload)

    await a.detach()
    await b.detach()
    expect(await hw.count()).toBe(0)
  })

  it('attaches a table, materialises it into real OPFS, opens one handle', async () => {
    const hw = makeHandleWorker()
    activeWorker = hw
    const { db, conn, queries } = makeRealHandleDb(hw)
    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([1, 2, 3, 4])),
      tables: [{ table: 'pages', files: [{ url: '/x', bytes: 4, contentHash: 'iceberg/a.parquet' }] }],
    })
    expect(handle.tables).toEqual(['pages'])
    expect(handle.degradedTables).toEqual([])
    expect(queries.some(s => s.includes('CREATE OR REPLACE VIEW main.pages'))).toBe(true)
    expect(await hw.count()).toBe(1)
    // The bytes really landed in OPFS.
    const root = await navigator.storage.getDirectory()
    const keys: string[] = []
    for await (const k of (root as any).keys()) keys.push(k)
    expect(keys.some(k => k.startsWith('gscdump-snapshot__pages_'))).toBe(true)
    await handle.detach()
  })

  it('two consumers sharing one DB attach the same file with NO real OPFS conflict', async () => {
    // The flagged root scenario, end to end: home fanout + per-site analyzer
    // share one DB and attach the same parquet. The registry dedups so only one
    // real sync access handle is opened; without it the second open would throw.
    const hw = makeHandleWorker()
    activeWorker = hw
    const { db, conn } = makeRealHandleDb(hw)
    const file = { url: '/shared', bytes: 5, contentHash: 'iceberg/shared.parquet' }
    const first = await attachOpfsParquetTables({ db, conn, fetch: okFetch(new Uint8Array([5, 5, 5, 5, 5])), tables: [{ table: 'dates', files: [file] }] })
    const second = await attachOpfsParquetTables({ db, conn, fetch: okFetch(new Uint8Array([5, 5, 5, 5, 5])), tables: [{ table: 'dates', files: [file] }] })
    expect(first.tables).toEqual(['dates'])
    expect(second.tables).toEqual(['dates'])
    expect(second.degradedTables).toEqual([])
    // One backing file → exactly one real sync access handle.
    expect(await hw.count()).toBe(1)
    // First consumer detaches: second still holds it, handle stays open.
    await first.detach()
    expect(await hw.count()).toBe(1)
    // Last consumer detaches: handle released.
    await second.detach()
    expect(await hw.count()).toBe(0)
  })

  it('re-attaching the same file after detach does not hit a stale-handle conflict (leak fixed)', async () => {
    // The original bug: detach never released the handle, so a later attach of
    // the same file collided with the leaked sync access handle. With release
    // wired in, the re-attach opens a fresh handle cleanly.
    const hw = makeHandleWorker()
    activeWorker = hw
    const { db, conn } = makeRealHandleDb(hw)
    const file = { url: '/r', bytes: 3, contentHash: 'iceberg/r.parquet' }
    const first = await attachOpfsParquetTables({ db, conn, fetch: okFetch(new Uint8Array([7, 7, 7])), tables: [{ table: 'pages', files: [file] }] })
    await first.detach()
    expect(await hw.count()).toBe(0)
    // Re-attach the SAME file — would throw the exclusivity error if the prior
    // handle had leaked.
    const second = await attachOpfsParquetTables({ db, conn, fetch: okFetch(new Uint8Array([7, 7, 7])), tables: [{ table: 'pages', files: [file] }] })
    expect(second.tables).toEqual(['pages'])
    expect(second.degradedTables).toEqual([])
    expect(await hw.count()).toBe(1)
    await second.detach()
  })

  it('two CONCURRENT attaches of the same file open exactly one real sync handle', async () => {
    // The TOCTOU race, end to end against real OPFS: two consumers attach the
    // same parquet on one shared DB at the same time. The real worker would
    // throw the exclusivity error on a double-register; the registry's per-name
    // serialisation must collapse the race to a single live handle.
    const hw = makeHandleWorker()
    activeWorker = hw
    const { db, conn } = makeRealHandleDb(hw)
    const file = { url: '/c', bytes: 4, contentHash: 'iceberg/concurrent.parquet' }
    const mk = () => attachOpfsParquetTables({ db, conn, fetch: okFetch(new Uint8Array([9, 9, 9, 9])), tables: [{ table: 'dates', files: [file] }] })

    const [first, second] = await Promise.all([mk(), mk()])
    expect(first.tables).toEqual(['dates'])
    expect(second.tables).toEqual(['dates'])
    expect(first.degradedTables).toEqual([])
    expect(second.degradedTables).toEqual([])
    expect(await hw.count()).toBe(1)

    await first.detach()
    expect(await hw.count()).toBe(1)
    await second.detach()
    expect(await hw.count()).toBe(0)
  })

  it('multi-file table: a conflict on file-1 releases file-0 — no leaked handle', async () => {
    // A two-file `pages` table. We pre-open file-1's backing handle in the
    // worker so the attach hits the REAL OPFS exclusivity error when it tries to
    // register file-1, degrading the table. The handle file-0 already opened
    // MUST be released — zero live handles afterwards (aside from the probe we
    // hold), proving the partial-materialise teardown releases real handles.
    const hw = makeHandleWorker()
    activeWorker = hw
    const { db, conn } = makeRealHandleDb(hw)
    // Compute file-1's OPFS name and pre-materialise + pre-open it to force the
    // conflict on registration.
    const file1Slug = await slugFor('iceberg/m1.parquet')
    const file1Name = `gscdump-snapshot__pages_${file1Slug}.parquet`
    const root = await navigator.storage.getDirectory()
    const fh = await root.getFileHandle(file1Name, { create: true })
    // Pre-write the correct 3 bytes so materialiseFile takes the cache-hit path
    // (no createWritable), then hold a sync access handle so REGISTRATION is what
    // hits the OPFS exclusivity conflict.
    const w = await fh.createWritable()
    await w.write(new Uint8Array([1, 2, 3]))
    await w.close()
    await hw.open(file1Name, fh) // now one live handle, held by us
    expect(await hw.count()).toBe(1)

    const handle = await attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([1, 2, 3])),
      fetchConcurrency: 1,
      tables: [{
        table: 'pages',
        files: [
          { url: '/m0', bytes: 3, contentHash: 'iceberg/m0.parquet' },
          { url: '/m1', bytes: 3, contentHash: 'iceberg/m1.parquet' },
        ],
      }],
    })
    expect(handle.degradedTables).toEqual(['pages'])
    expect(handle.tables).toEqual([])
    // Only the probe handle we opened ourselves remains — file-0's handle was
    // acquired then released by the degrade teardown. Count is back to 1.
    expect(await hw.count()).toBe(1)
    await hw.close(file1Name)
  })

  it('abort mid-attach releases every real handle (no leak)', async () => {
    const hw = makeHandleWorker()
    activeWorker = hw
    const { db, conn: baseConn } = makeRealHandleDb(hw)
    const controller = new AbortController()
    // Abort once the first view query is issued.
    const conn = {
      async query(sql: string) {
        if (sql.includes('CREATE OR REPLACE VIEW'))
          controller.abort()
        return baseConn.query(sql)
      },
    } as unknown as typeof baseConn

    await expect(attachOpfsParquetTables({
      db,
      conn,
      fetch: okFetch(new Uint8Array([4, 4, 4, 4])),
      signal: controller.signal,
      tables: [
        { table: 'queries', files: [{ url: '/aq', bytes: 4, contentHash: 'iceberg/aq.parquet' }] },
        { table: 'pages', files: [{ url: '/ap', bytes: 4, contentHash: 'iceberg/ap.parquet' }] },
      ],
    })).rejects.toThrow()

    // Both files opened real handles during the download loop; the abort
    // teardown must release them all.
    expect(await hw.count()).toBe(0)
  })
})

/** Replicates the 16-hex-char slug `opfs.ts` derives from a `contentHash`. */
async function slugFor(contentHash: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contentHash))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < 8; i++)
    hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}
