// Host-neutral binding contract for the analytics layer.
//
// The layer needs a narrow set of Cloudflare-style bindings (R2 bucket,
// optional D1 for the manifest mirror, an optional DuckDB service binding,
// routing flags). gscdump.com's `CloudflareEnv` is a superset that also
// covers auth, billing, sync jobs — things the layer has no business knowing.
//
// Instead of importing the host's env type, the layer defines its own
// minimal interface. Hosts populate it via a Nitro plugin (CF adapter wiring
// on gscdump.com; a thin `event.context.analyticsEnv = { ... }` stub on
// non-CF consumers).

/// <reference types="@cloudflare/workers-types" />

export interface AnalyticsEnv {
  /** R2 bucket holding parquet + rollup + entity data. Required in origin mode. */
  R2_DATA?: R2Bucket
  /** Human name of the R2 bucket (used by the presigner when building public URLs). */
  R2_BUCKET_NAME?: string
  /** Optional: D1 database holding the r2_manifest mirror + sync state. */
  DB?: D1Database
  /**
   * Optional: DuckDB service binding (Workers RPC) for server-side execution.
   * Structural shape — any binding with `runSQL` + `ping` satisfies it, so
   * hosts can declare their own binding interface without coupling to this one.
   * Request tables use Arrow IPC chunks. Small queries pass tables inline to
   * `runSQL`; larger queries stage chunks via `stageArrowTable`, then call
   * `runSQL` with only SQL, and finally `dropTables`.
   */
  DUCKDB_SVC?: {
    runSQL: (args: { sql: string, tables?: Record<string, { ipc: Uint8Array }>, deadlineAt?: number }) => Promise<{ rows: unknown[], sql: string }>
    stageArrowTable?: (args: { table: string, ipc: Uint8Array }) => Promise<void>
    dropTables?: (args: { tables: string[] }) => Promise<void>
    ping: () => Promise<string>
  }
  /** Route override: force D1 as the manifest source even if R2 is bound. */
  ANALYTICS_FORCE_D1?: string
  /** Route override: disable R2 reads entirely (consumer / legacy mode). */
  R2_READS_ENABLED?: string

  /** R2 S3-API credentials for presigning (origin mode when the worker can't proxy). */
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  CLOUDFLARE_ACCOUNT_ID?: string
}
