// Node InspectionSqlDriver factory backed by better-sqlite3. Imported from
// a subpath so edge bundles that can't build native modules don't pull it
// in transitively via the root barrel.
//
// Usage:
//   import { createInspectionStoreSqlite } from '@gscdump/engine/entities'
//   import { createBetterSqliteDriver } from '@gscdump/engine/inspection-sqlite-node'
//   const store = createInspectionStoreSqlite({
//     dataSource,
//     openDriver: bytes => createBetterSqliteDriver(bytes),
//   })

import type { InspectionSqlDriver } from '../entities'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(typeof __filename !== 'undefined' ? __filename : (typeof import.meta !== 'undefined' ? fileURLToPath(import.meta.url) : process.cwd()))

interface BetterSqliteStatement {
  run: (...params: unknown[]) => unknown
  all: (...params: unknown[]) => unknown[]
}

interface BetterSqliteDatabase {
  exec: (sql: string) => void
  prepare: (sql: string) => BetterSqliteStatement
  serialize: () => Buffer
  close: () => void
}

type BetterSqliteCtor = new (path: string | Buffer, opts?: { fileMustExist?: boolean, readonly?: boolean }) => BetterSqliteDatabase

function loadBetterSqlite(): BetterSqliteCtor {
  // Lazy require keeps `createRequire` side-effects contained to this module
  // and gives a clearer error when the optional peer is missing.
  const mod = require_('better-sqlite3') as BetterSqliteCtor | { default: BetterSqliteCtor }
  return (typeof mod === 'function' ? mod : mod.default) as BetterSqliteCtor
}

export function createBetterSqliteDriver(bytes: Uint8Array | undefined): InspectionSqlDriver {
  const Database = loadBetterSqlite()
  // better-sqlite3 accepts a Buffer to restore from serialized bytes; an
  // empty string falls through to an in-memory DB for the fresh-open case.
  const db: BetterSqliteDatabase = bytes
    ? new Database(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    : new Database(':memory:')

  return {
    exec(sql) {
      db.exec(sql)
    },
    run(sql, params) {
      db.prepare(sql).run(...params)
    },
    all(sql, params) {
      return db.prepare(sql).all(...params) as unknown[]
    },
    serialize() {
      const buf = db.serialize()
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    },
    close() {
      db.close()
    },
  }
}
