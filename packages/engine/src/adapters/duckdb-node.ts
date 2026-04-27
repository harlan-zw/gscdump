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

export function createNodeDuckDBHandle(opts: NodeDuckDBOptions = {}): DuckDBHandle {
  if (!singleton)
    singleton = initialize(opts)

  return {
    async query(sql: string, params?: unknown[]): Promise<Row[]> {
      const { conn } = await singleton!
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
      const { db } = await singleton!
      db.registerFileBuffer(name, bytes)
    },
    async copyFileToBuffer(name: string): Promise<Uint8Array> {
      const { db } = await singleton!
      return db.copyFileToBuffer(name)
    },
    async dropFiles(names: string[]): Promise<void> {
      const { db } = await singleton!
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
  singleton = null
}
