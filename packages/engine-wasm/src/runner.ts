/**
 * Insight runner primitives: a mode-agnostic drizzle handle bound to an
 * AsyncDuckDBConnection (snapshot buffer, snapshot over httpfs, hot/cold
 * UNION, parquet-views, engine/manifest — whichever the caller already has
 * attached), plus scope helpers that produce predicates for multi-tenant /
 * windowed queries so consumers don't re-implement date math.
 *
 * Typed escape hatch via `db.execute(sql\`SELECT ...\`)` — use `sql<Row>\`\``
 * from drizzle-orm for typed result rows on exotic queries that the builder
 * can't express cleanly.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import type { ScopedRunnerOptions, TableScope } from '@gscdump/engine/scope'

import type { DuckDBWasmClient, DuckDBWasmDrizzleDatabase } from './drizzle-adapter'
import type { Schema } from './schema'

import { createScopedHelpers } from '@gscdump/engine/scope'

import { createClient, drizzle } from './drizzle-adapter'
import { schema } from './schema'

export type { ScopedRunnerOptions, TableScope }

export interface InsightRunnerOptions {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  logger?: boolean
}

export interface InsightRunner {
  db: DuckDBWasmDrizzleDatabase<Schema>
  client: Promise<DuckDBWasmClient>
  close: () => Promise<void>
}

export async function createInsightRunner(opts: InsightRunnerOptions): Promise<InsightRunner> {
  const client = await createClient(opts.db, opts.conn)
  const clientPromise = Promise.resolve(client)
  const db = drizzle(clientPromise, {
    schema,
    logger: opts.logger,
  })

  return {
    db,
    client: clientPromise,
    close: () => client.close(),
  }
}

/**
 * Build a per-table predicate set from {siteId, window}. The returned
 * `wherePredicates` composes with user-level filters via `mergeScope`.
 *
 * Note: the current SCHEMAS don't include `site_id` on any table (snapshots
 * are already per-site), so `siteId` is a no-op for now — kept in the API
 * so consumers can add the predicate without an interface change when
 * multi-site snapshots land.
 */
export const { scopeFor, mergeScope } = createScopedHelpers(schema)
