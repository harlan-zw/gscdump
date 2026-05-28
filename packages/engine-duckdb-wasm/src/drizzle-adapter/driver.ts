/**
 * Drizzle driver for DuckDB-WASM — typed SQL builder surface over an
 * AsyncDuckDB connection.
 *
 * Adapted from @proj-airi/drizzle-duckdb-wasm (MIT, (c) 2024 Neko Ayaka).
 * Stripped to the minimum: no DSN parsing, no bundle loading. Callers pass
 * their own client (built via createClient from ./client), so the wiring
 * composes cleanly with gscdump's existing DuckDB-WASM setup in the demo
 * and in `@gscdump/engine/node`.
 *
 * Targets drizzle-orm 1.0.x. The analytics workload primarily uses the SQL
 * builder (`db.select()` / `db.execute()`), while `config.schema` is still
 * converted into Drizzle's relation config so the public database type stays
 * tied to the caller's schema.
 */

import type { DrizzleConfig, Logger } from 'drizzle-orm'
import type { AnyRelations, Schema as DrizzleSchema, EmptyRelations, ExtractTablesWithRelations } from 'drizzle-orm/relations'

import type { DuckDBWasmClient } from './client'
import type { DuckDBWasmQueryResultHKT } from './session'

import { DefaultLogger, entityKind } from 'drizzle-orm'
import { PgAsyncDatabase, PgDialect } from 'drizzle-orm/pg-core'
import { buildRelations } from 'drizzle-orm/relations'

import { DuckDBWasmSession } from './session'

type SchemaRelations<TSchema extends DrizzleSchema> = ExtractTablesWithRelations<Record<string, never>, TSchema>

export class DuckDBWasmDatabase<
  TRelations extends AnyRelations = EmptyRelations,
> extends PgAsyncDatabase<DuckDBWasmQueryResultHKT, TRelations> {
  static override readonly [entityKind]: string = 'DuckDBWasmDatabase'
}

export interface DuckDBWasmDrizzleDatabase<
  TSchema extends DrizzleSchema = Record<string, never>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> extends DuckDBWasmDatabase<TRelations> {
  $client: Promise<DuckDBWasmClient>
}

export function drizzle<
  TSchema extends DrizzleSchema = Record<string, never>,
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
>(
  client: Promise<DuckDBWasmClient> | DuckDBWasmClient,
  config: DrizzleConfig<TSchema, TRelations> = {},
): DuckDBWasmDrizzleDatabase<TSchema, TRelations> {
  const dialect = new PgDialect()
  const clientPromise = Promise.resolve(client)

  let logger: Logger | undefined
  if (config.logger === true)
    logger = new DefaultLogger()
  else if (config.logger !== false)
    logger = config.logger

  const session = new DuckDBWasmSession(clientPromise, dialect, { logger, cache: config.cache })
  const relations = (config.relations ?? (config.schema ? buildRelations(config.schema, {}) : {})) as TRelations
  const db = new DuckDBWasmDatabase(
    dialect,
    session,
    relations,
  ) as DuckDBWasmDrizzleDatabase<TSchema, TRelations>

  ;(db as any).$client = clientPromise
  return db
}
