// Node-only DuckDB handle, built on the blocking bindings (no worker, no
// fetch). Used by the CLI's integration tests and by `gscdump query` in the
// CLI package. For browsers / Cloudflare Workers, ship an AsyncDuckDB-based
// handle from the adapter layer of the consuming app.

import type { DuckDBHandle } from '../duckdb'
import type { Row } from '../storage'
import { unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
// @ts-expect-error - blocking variant ships as CJS, no type export published
import { ConsoleLogger, createDuckDB, NODE_RUNTIME, VoidLogger } from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'
import { arrowToRows } from '../arrow-utils'

const require_ = createRequire(typeof __filename !== 'undefined' ? __filename : (typeof import.meta !== 'undefined' ? fileURLToPath(import.meta.url) : process.cwd()))

export interface NodeDuckDBOptions {
  verbose?: boolean
}

interface DuckDBNodeBindings {
  instantiate: () => Promise<DuckDBNodeBindings>
  connect: () => DuckDBConnection
  registerFileBuffer: (name: string, bytes: Uint8Array) => void
  copyFileToBuffer: (name: string) => Uint8Array
  dropFile: (name: string) => void
  dropFiles: (names?: string[]) => void
  reset: () => void
}

interface DuckDBConnection {
  query: (sql: string) => unknown
  prepare: (sql: string) => PreparedStatementLike
  close: () => void
}

interface PreparedStatementLike {
  query: (...params: unknown[]) => unknown
  close: () => void
}

let singleton: Promise<{ db: DuckDBNodeBindings, conn: DuckDBConnection }> | null = null
// Opts captured on first init. The instance is a process-wide singleton, so a
// later caller's opts can't re-configure it; we keep the first set to detect
// (and warn about) a divergent second request rather than silently dropping it.
let singletonOpts: NodeDuckDBOptions | null = null

function bundles(): unknown {
  return {
    mvp: {
      mainModule: require_.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'),
      mainWorker: null,
    },
    eh: {
      mainModule: require_.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'),
      mainWorker: null,
    },
  }
}

async function initialize(opts: NodeDuckDBOptions): Promise<{ db: DuckDBNodeBindings, conn: DuckDBConnection }> {
  const logger = opts.verbose ? new ConsoleLogger() : new VoidLogger()
  const db = (await createDuckDB(bundles(), logger, NODE_RUNTIME)) as DuckDBNodeBindings
  await db.instantiate()
  const conn = db.connect()
  return { db, conn }
}

/**
 * Return the live instance, initializing it on demand. Lazy so a handle held
 * across a `resetNodeDuckDB()` (which nulls `singleton`) transparently re-inits
 * on its next call instead of dereferencing null — the handle stays usable for
 * its whole lifetime regardless of reset cycles. Silent by design: the
 * divergent-opts warning fires once at `createNodeDuckDBHandle` time, not on
 * every method call.
 */
function getSingleton(opts: NodeDuckDBOptions): Promise<{ db: DuckDBNodeBindings, conn: DuckDBConnection }> {
  if (!singleton) {
    singleton = initialize(opts)
    singletonOpts = opts
  }
  return singleton
}

export function createNodeDuckDBHandle(opts: NodeDuckDBOptions = {}): DuckDBHandle {
  if (singleton && opts.verbose !== undefined && opts.verbose !== (singletonOpts?.verbose ?? false)) {
    // The shared instance is already running; its logger can't be swapped. Say
    // so instead of silently honoring the first caller's verbosity only.
    console.warn(
      `[gscdump] createNodeDuckDBHandle: ignoring verbose=${opts.verbose} — a shared `
      + `DuckDB instance was already initialized with verbose=${singletonOpts?.verbose ?? false}. `
      + `Call resetNodeDuckDB() before re-initializing to change it.`,
    )
  }
  // Eagerly ensure the instance exists at create time (preserves the historical
  // init-on-create timing); `getSingleton` then re-inits lazily if a later
  // reset nulls it out from under this handle.
  void getSingleton(opts)

  return {
    async query(sql: string, params?: unknown[]): Promise<Row[]> {
      const { conn } = await getSingleton(opts)
      if (!params || params.length === 0) {
        const result = conn.query(sql)
        return arrowToRows(result) as Row[]
      }
      const stmt = conn.prepare(sql)
      try {
        const result = stmt.query(...params)
        return arrowToRows(result) as Row[]
      }
      finally {
        stmt.close()
      }
    },
    async registerFileBuffer(name: string, bytes: Uint8Array): Promise<void> {
      const { db } = await getSingleton(opts)
      db.registerFileBuffer(name, bytes)
    },
    async copyFileToBuffer(name: string): Promise<Uint8Array> {
      const { db } = await getSingleton(opts)
      return db.copyFileToBuffer(name)
    },
    async dropFiles(names: string[]): Promise<void> {
      const { db } = await getSingleton(opts)
      for (const name of names) {
        try {
          db.dropFile(name)
        }
        catch {
          // tolerate missing files
        }
        // `COPY TO '...'` under NODE_RUNTIME writes to the actual filesystem;
        // `dropFile` only unregisters the virtual-FS entry. Unlink the real
        // file too so codec temp outputs don't accumulate.
        try {
          unlinkSync(name)
        }
        catch {
          // fine — either virtual-only or already gone
        }
      }
    },
    makeTempPath(ext: string): string {
      return join(tmpdir(), `gscdump-${Math.random().toString(36).slice(2, 10)}.${ext}`)
    },
  }
}

export function resetNodeDuckDB(): void {
  const pending = singleton
  // Null the singleton first so the next `createNodeDuckDBHandle` re-inits a
  // fresh instance rather than racing the teardown below.
  singleton = null
  singletonOpts = null
  // Best-effort: close the connection and reset the bindings so the native
  // DuckDB instance is released instead of leaking across CLI/test runs.
  // Fire-and-forget keeps the synchronous signature the many call sites rely on.
  void pending
    ?.then(({ db, conn }) => {
      conn.close()
      db.reset()
    })
    // Don't swallow silently: a failed release means a leaked native instance,
    // which compounds across long CLI/test runs. Surface it so it's diagnosable.
    .catch((err) => {
      console.warn('[gscdump] resetNodeDuckDB: failed to release DuckDB instance', err)
    })
}
