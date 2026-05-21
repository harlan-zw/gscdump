/**
 * Re-export of the canonical drizzle pg-core schema from `@gscdump/engine`.
 * DuckDB speaks Postgres-flavored SQL, so the browser adapter uses the
 * same drizzle tables the storage layer does — no drift guard needed.
 */

export {
  countries,
  dates,
  hourly_pages,
  page_queries,
  pages,
  queries,
  drizzleSchema as schema,
} from '@gscdump/engine/schema'
export type { DrizzleSchema as Schema } from '@gscdump/engine/schema'
