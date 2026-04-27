// Browser InspectionSqlDriver factory backed by wa-sqlite. Async-only:
// wa-sqlite's SQLite3 API returns promises for everything. Imported from
// a subpath so node bundles don't drag the wasm loader into their tree.
//
// Usage:
//   import { createInspectionStoreSqlite } from '@gscdump/engine/entities'
//   import { createWaSqliteDriver } from '@gscdump/engine/inspection-sqlite-browser'
//   const store = createInspectionStoreSqlite({
//     dataSource,
//     openDriver: bytes => createWaSqliteDriver(bytes),
//   })

import type { InspectionSqlDriver } from '../entities'

// wa-sqlite's factory + SQLite3 surface, narrowed to what we call. We avoid
// depending on `@types/wa-sqlite` (which isn't published) and keep this
// file self-describing.
interface WaSqliteApi {
  open_v2: (name: string) => Promise<number>
  close: (db: number) => Promise<number>
  exec: (db: number, sql: string) => Promise<number>
  prepare_v2: (db: number, sql: string) => Promise<{ stmt: number, sql: Int8Array } | null>
  bind_collection: (stmt: number, params: unknown[]) => number
  step: (stmt: number) => Promise<number>
  column_count: (stmt: number) => number
  column_name: (stmt: number, i: number) => string
  column: (stmt: number, i: number) => unknown
  reset: (stmt: number) => Promise<number>
  finalize: (stmt: number) => Promise<number>
  serialize: (db: number, zSchema: string) => Promise<Uint8Array>
  deserialize: (db: number, zSchema: string, bytes: Uint8Array) => Promise<number>
  SQLITE_ROW: number
  SQLITE_DONE: number
}

interface WaSqliteModule {
  default: () => Promise<unknown>
}

interface WaSqliteFactory {
  Factory: (mod: unknown) => WaSqliteApi
  SQLITE_ROW: number
  SQLITE_DONE: number
}

export async function createWaSqliteDriver(bytes: Uint8Array | undefined): Promise<InspectionSqlDriver> {
  // Resolve wa-sqlite lazily: the package ships an ESM factory for the wasm
  // module and a separate Factory that wraps it into the SQLite3 API. We
  // import at call time so the wasm payload is only fetched when the store
  // is actually used.
  const [factoryMod, apiMod] = await Promise.all([
    import('wa-sqlite/dist/wa-sqlite.mjs' as string) as Promise<WaSqliteModule>,
    import('wa-sqlite' as string) as Promise<WaSqliteFactory>,
  ])
  const wasmModule = await factoryMod.default()
  const sqlite3 = apiMod.Factory(wasmModule)

  const db = await sqlite3.open_v2(':memory:')
  if (bytes && bytes.byteLength > 0)
    await sqlite3.deserialize(db, 'main', bytes)

  async function runStatement(sql: string, params: unknown[]): Promise<unknown[]> {
    const prepared = await sqlite3.prepare_v2(db, sql)
    if (!prepared)
      return []
    const { stmt } = prepared
    const rows: unknown[] = []
    sqlite3.bind_collection(stmt, params)
    let rc = await sqlite3.step(stmt)
    while (rc === sqlite3.SQLITE_ROW) {
      const colCount = sqlite3.column_count(stmt)
      const row: Record<string, unknown> = {}
      for (let i = 0; i < colCount; i++)
        row[sqlite3.column_name(stmt, i)] = sqlite3.column(stmt, i)
      rows.push(row)
      rc = await sqlite3.step(stmt)
    }
    await sqlite3.finalize(stmt)
    return rows
  }

  return {
    async exec(sql) {
      await sqlite3.exec(db, sql)
    },
    async run(sql, params) {
      await runStatement(sql, params)
    },
    async all(sql, params) {
      return runStatement(sql, params)
    },
    async serialize() {
      return sqlite3.serialize(db, 'main')
    },
    async close() {
      await sqlite3.close(db)
    },
  }
}
