/**
 * Drizzle PgAsyncSession adapter for DuckDB-WASM.
 *
 * Adapted from @proj-airi/drizzle-duckdb-wasm (MIT, (c) 2024 Neko Ayaka).
 * Updated for drizzle-orm 1.0.x (RQBv2 async session surface). Transactions
 * throw — the analytics workload is read-only; wire a real implementation
 * here if that changes.
 */

import type { Assume, Logger, Query } from 'drizzle-orm'
import type { Cache } from 'drizzle-orm/cache/core'
import type { WithCacheConfig } from 'drizzle-orm/cache/core/types'
import type { PgDialect, PgQueryResultHKT, PreparedQueryConfig } from 'drizzle-orm/pg-core'

import type { DuckDBWasmClient } from './client'

import { entityKind, NoopLogger } from 'drizzle-orm'
import { PgAsyncPreparedQuery, PgAsyncSession } from 'drizzle-orm/pg-core'

export type Row = Record<string, unknown>

interface QueryMetadata { type: 'select' | 'update' | 'delete' | 'insert', tables: string[] }

export interface DuckDBWasmSessionOptions {
  logger?: Logger
  cache?: Cache
}

export class DuckDBWasmSession extends PgAsyncSession<DuckDBWasmQueryResultHKT> {
  static override readonly [entityKind]: string = 'DuckDBWasmSession'

  private logger: Logger
  private cache?: Cache

  constructor(
    public client: Promise<DuckDBWasmClient>,
    dialect: PgDialect,
    readonly options: DuckDBWasmSessionOptions = {},
  ) {
    super(dialect)
    this.logger = options.logger ?? new NoopLogger()
    this.cache = options.cache
  }

  override prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    mode: 'arrays' | 'objects' | 'raw',
    _name: string | boolean,
    mapper?: (rows: any[]) => any,
    queryMetadata?: QueryMetadata,
    cacheConfig?: WithCacheConfig,
  ): PgAsyncPreparedQuery<T> {
    const client = this.client
    const executor = async (params: unknown[] = []): Promise<unknown[]> => {
      const c = await client
      const rows = await c.query(query.sql, params)
      // DuckDB returns row objects; arrays mode wants positional value tuples.
      return mode === 'arrays' ? rows.map(row => Object.values(row)) : rows
    }
    return new PgAsyncPreparedQuery<T>(
      executor,
      query,
      mapper,
      mode,
      this.logger,
      this.cache,
      queryMetadata,
      cacheConfig,
    )
  }

  override transaction<T>(): Promise<T> {
    throw new Error(
      'Transactions are not supported by the DuckDB-WASM drizzle adapter. '
      + 'The analytics workload is read-only; if transactions become necessary, '
      + 'implement PgAsyncSession.transaction() in @gscdump/engine-duckdb-wasm.',
    )
  }
}

export interface DuckDBWasmQueryResultHKT extends PgQueryResultHKT {
  type: Assume<this['row'], Row>[]
}
