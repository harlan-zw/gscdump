import type { SQL } from 'drizzle-orm'

import { PgDialect } from 'drizzle-orm/pg-core'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'

const pgDialect = new PgDialect()
const sqliteDialect = new SQLiteAsyncDialect()

export function compilePg(query: SQL): { sql: string, params: unknown[] } {
  const compiled = pgDialect.sqlToQuery(query)
  return { sql: compiled.sql, params: compiled.params as unknown[] }
}

export function compileSqlite(query: SQL): { sql: string, params: unknown[] } {
  const compiled = sqliteDialect.sqlToQuery(query)
  return { sql: compiled.sql, params: compiled.params as unknown[] }
}
