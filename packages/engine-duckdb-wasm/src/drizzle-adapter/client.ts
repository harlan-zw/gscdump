/**
 * Minimal DuckDB-WASM client surface for the drizzle session.
 *
 * Adapted from @proj-airi/duckdb-wasm (MIT, (c) 2024 Neko Ayaka).
 * Simplified: no bundle loading, no OPFS/NodeFS storage. Callers pass an
 * already-connected AsyncDuckDB — matches how gscdump's existing browser
 * demo wires DuckDB-WASM.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { arrowToRows } from '@gscdump/engine/arrow'

export interface DuckDBWasmClient {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
  close: () => Promise<void>
}

export async function createClient(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
): Promise<DuckDBWasmClient> {
  return {
    db,
    conn,
    async query(sql: string, params: unknown[] = []) {
      if (params.length === 0) {
        const res = await conn.query(sql)
        return arrowToRows(res)
      }
      const stmt = await conn.prepare(sql)
      try {
        const res = await stmt.query(...params)
        return arrowToRows(res)
      }
      finally {
        await stmt.close()
      }
    },
    async close() {
      await conn.close()
    },
  }
}
