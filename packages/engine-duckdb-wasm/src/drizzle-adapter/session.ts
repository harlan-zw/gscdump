/**
 * Drizzle PgSession adapter for DuckDB-WASM.
 *
 * Adapted from @proj-airi/drizzle-duckdb-wasm (MIT, (c) 2024 Neko Ayaka).
 * Updated for drizzle-orm 0.45.x. Transactions throw — the analytics
 * workload is read-only; wire a real implementation here if that changes.
 */

import type { Assume, Logger, Query, RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm'
import type { Cache } from 'drizzle-orm/cache/core'
import type {
  PgDialect,
  PgQueryResultHKT,
  PgTransactionConfig,
  PreparedQueryConfig,
  SelectedFieldsOrdered,
} from 'drizzle-orm/pg-core'

import type { DuckDBWasmClient } from './client'

import { entityKind, fillPlaceholders, NoopLogger } from 'drizzle-orm'
import { PgPreparedQuery, PgSession } from 'drizzle-orm/pg-core'

export type Row = Record<string, unknown>

interface QueryMetadata { type: 'select' | 'update' | 'delete' | 'insert', tables: string[] }

class DuckDBWasmPreparedQuery<T extends PreparedQueryConfig> extends PgPreparedQuery<T> {
  static override readonly [entityKind]: string = 'DuckDBWasmPreparedQuery'

  constructor(
    private client: Promise<DuckDBWasmClient>,
    query: Query,
    private logger: Logger,
    queryMetadata: QueryMetadata | undefined,
    cache?: Cache,
  ) {
    super(query, cache, queryMetadata)
  }

  async execute(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['execute']> {
    const params = fillPlaceholders(this.query.params, placeholderValues)
    this.logger.logQuery(this.query.sql, params)
    const c = await this.client
    return (await c.query(this.query.sql, params)) as T['execute']
  }

  async all(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['all']> {
    const params = fillPlaceholders(this.query.params, placeholderValues)
    this.logger.logQuery(this.query.sql, params)
    const c = await this.client
    return (await c.query(this.query.sql, params)) as T['all']
  }
}

export interface DuckDBWasmSessionOptions {
  logger?: Logger
  cache?: Cache
}

export class DuckDBWasmSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends PgSession<DuckDBWasmQueryResultHKT, TFullSchema, TSchema> {
  static override readonly [entityKind]: string = 'DuckDBWasmSession'

  logger: Logger
  cache?: Cache

  constructor(
    public client: Promise<DuckDBWasmClient>,
    dialect: PgDialect,
    _schema: RelationalSchemaConfig<TSchema> | undefined,
    readonly options: DuckDBWasmSessionOptions = {},
  ) {
    super(dialect)
    this.logger = options.logger ?? new NoopLogger()
    this.cache = options.cache
  }

  prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    _fields: SelectedFieldsOrdered | undefined,
    _name: string | undefined,
    _isResponseInArrayMode: boolean,
    _customResultMapper?: (rows: unknown[][]) => T['execute'],
    queryMetadata?: QueryMetadata,
  ): PgPreparedQuery<T> {
    return new DuckDBWasmPreparedQuery(
      this.client,
      query,
      this.logger,
      queryMetadata,
      this.cache,
    )
  }

  async query(sql: string, params: unknown[]): Promise<Row[]> {
    this.logger.logQuery(sql, params)
    const c = await this.client
    return c.query(sql, params)
  }

  transaction<T>(
    _transaction: unknown,
    _config?: PgTransactionConfig,
  ): Promise<T> {
    throw new Error(
      'Transactions are not supported by the DuckDB-WASM drizzle adapter. '
      + 'The analytics workload is read-only; if transactions become necessary, '
      + 'implement PgSession.transaction() in @gscdump/engine-duckdb-wasm.',
    )
  }
}

export interface DuckDBWasmQueryResultHKT extends PgQueryResultHKT {
  type: Assume<this['row'], Row>[]
}
