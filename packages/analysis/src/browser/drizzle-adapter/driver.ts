/**
 * Drizzle driver for DuckDB-WASM — typed SQL builder surface over an
 * AsyncDuckDB connection.
 *
 * Adapted from @proj-airi/drizzle-duckdb-wasm (MIT, (c) 2024 Neko Ayaka).
 * Stripped to the minimum: no DSN parsing, no bundle loading. Callers pass
 * their own client (built via createClient from ./client), so the wiring
 * composes cleanly with gscdump's existing DuckDB-WASM setup in the demo
 * and in @gscdump/analysis/duckdb/*.
 */

import type { DrizzleConfig, RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm'

import type { DuckDBWasmClient } from './client'
import type { DuckDBWasmQueryResultHKT } from './session'

import { createTableRelationsHelpers, DefaultLogger, entityKind, extractTablesRelationalConfig } from 'drizzle-orm'
import { PgDatabase, PgDialect } from 'drizzle-orm/pg-core'

import { DuckDBWasmSession } from './session'

export class DuckDBWasmDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends PgDatabase<DuckDBWasmQueryResultHKT, TSchema> {
  static override readonly [entityKind]: string = 'DuckDBWasmDatabase'
}

export interface DuckDBWasmDrizzleDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends DuckDBWasmDatabase<TSchema> {
  $client: Promise<DuckDBWasmClient>
}

export function drizzle<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  client: Promise<DuckDBWasmClient> | DuckDBWasmClient,
  config: DrizzleConfig<TSchema> = {},
): DuckDBWasmDrizzleDatabase<TSchema> {
  const dialect = new PgDialect({ casing: config.casing })
  const clientPromise = Promise.resolve(client)

  let logger
  if (config.logger === true)
    logger = new DefaultLogger()
  else if (config.logger !== false)
    logger = config.logger

  let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(
      config.schema,
      createTableRelationsHelpers,
    )
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    }
  }

  const session = new DuckDBWasmSession(clientPromise, dialect, schema, { logger })
  const db = new DuckDBWasmDatabase(dialect, session, schema as any) as DuckDBWasmDatabase<TSchema>

  ;(db as any).$client = clientPromise
  return db as DuckDBWasmDrizzleDatabase<TSchema>
}
