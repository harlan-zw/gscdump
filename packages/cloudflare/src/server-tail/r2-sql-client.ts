// R2 SQL client — server-tail executor for the `r2-sql` / `r2-sql-resolved`
// archetypes.
//
// R2 SQL is Cloudflare's HTTP query API over an Iceberg table in R2 Data
// Catalog. It is the server tail for whale deep-history that exceeds the
// browser OPFS ceiling: archetypes 1, 5, 6, 7, 8 directly, and 2, 3, 4 once
// the resolver has pre-resolved their entity selections to literal `IN` lists
// (the `r2-sql-resolved` class — see `ARCHETYPE_EXECUTION_CLASS`).
//
// API shape (Cloudflare R2 SQL): a POST to
//   https://api.sql.cloudflarestorage.com/api/v1/accounts/{account}/r2-sql/query/{bucket}
// with `{ "query": "<SQL>" }`, Bearer-token authed (the R2-Data-Catalog-scoped
// token — the management `api.cloudflare.com/client/v4/.../r2-catalog/` API is a
// DIFFERENT service and 404s for queries). R2 SQL addresses the catalog by
// BUCKET, not warehouse. The response is the CF envelope `{ success, result,
// errors }` where `result` carries columns + rows. R2 SQL does NOT support bound
// parameters, so this client inlines params via `escapeSqlValue` before sending.
//
// CAVEAT — identity-partition equality: R2 SQL returns zero rows on a literal
// equality against an identity-partition column (here `site_id` / `search_type`)
// unless the column is materialized; `runPlan` wraps those predicates in
// `CONCAT(col, '')` to force it. The client is testable by injecting a `fetch`
// impl that returns a recorded CF envelope; see the sibling tests.

import type { ArchetypeQuery } from '@gscdump/sdk'
import type { ArchetypeSqlPlan } from './archetype-sql'
import { buildArchetypeSql, TABLE_PLACEHOLDER } from './archetype-sql'

/** Iceberg table name → fully-qualified R2 SQL table reference. */
function r2TableRef(namespace: string, table: string): string {
  // R2 SQL addresses an Iceberg table as `namespace.table` inside the
  // warehouse. Both identifiers are our own constants, never user input.
  return `${namespace}.${table}`
}

/** Configuration for an R2 SQL client. */
export interface R2SqlClientConfig {
  /** Cloudflare account id. */
  accountId: string
  /** R2 bucket backing the Iceberg catalog — R2 SQL addresses the catalog by bucket. */
  bucket: string
  /** Iceberg namespace the 5 fact tables live in. */
  namespace: string
  /** Cloudflare API token with R2 Data Catalog read scope. */
  token: string
  /**
   * Override the HTTP endpoint base. Defaults to the public CF API. Tests
   * point this at a local recorder.
   */
  apiBase?: string
  /**
   * Injectable fetch. Defaults to global `fetch`. Tests pass a fake that
   * returns a recorded CF envelope without a network round-trip.
   */
  fetchImpl?: typeof fetch
  /** Per-query wall-clock deadline (ms). Default 25s — under the Worker CPU budget. */
  timeoutMs?: number
}

/** A row as returned by R2 SQL — flat dimension + metric values. */
export type R2SqlRow = Record<string, string | number | null>

/** Result of an R2 SQL query. */
export interface R2SqlResult {
  rows: R2SqlRow[]
  /** The exact SQL sent (params already inlined). For diagnostics. */
  sql: string
  /** Wall-clock duration of the HTTP round-trip. */
  queryMs: number
}

export class R2SqlError extends Error {
  override name = 'R2SqlError'
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export class R2SqlTimeoutError extends Error {
  override name = 'R2SqlTimeoutError'
  constructor(timeoutMs: number) {
    super(`R2 SQL query exceeded ${timeoutMs}ms deadline`)
  }
}

const DEFAULT_API_BASE = 'https://api.sql.cloudflarestorage.com/api/v1'
const DEFAULT_TIMEOUT_MS = 25_000

// R2 SQL returns zero rows on a literal equality against an identity-partition
// column unless the column is materialized; wrapping it in `CONCAT(col, '')`
// forces materialization and the predicate works. `buildArchetypeSql` always
// emits `site_id` / `search_type` as the (bare) partition predicate, so target
// that form. Idempotent: the wrapped `site_id` inside `CONCAT(...)` is followed
// by `,`, never `=`, so it won't re-match.
const PARTITION_PREDICATE_RE = /\b(site_id|search_type)(\s*=)/g
function workaroundPartitionEquality(sql: string): string {
  return sql.replace(PARTITION_PREDICATE_RE, (_m, col: string, eq: string) => `CONCAT(${col}, '')${eq}`)
}

/**
 * Escape a JS value for inline embedding in R2 SQL. R2 SQL has no bound-param
 * channel, so `buildArchetypeSql`'s `?` placeholders are substituted here.
 * Numbers go in bare; strings are single-quote-escaped; null → `NULL`.
 */
export function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined)
    return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new R2SqlError(`cannot embed non-finite number in SQL: ${value}`)
    return String(value)
  }
  if (typeof value === 'bigint')
    return value.toString()
  if (typeof value === 'boolean')
    return value ? 'TRUE' : 'FALSE'
  return `'${String(value).replace(/'/g, '\'\'')}'`
}

/**
 * Inline a plan's `?`-bound params into its SQL, in order. R2 SQL accepts only
 * a literal query string. Quote-aware so a `?` inside a string literal is not
 * mistaken for a placeholder.
 */
export function inlineParams(sql: string, params: readonly unknown[]): string {
  let out = ''
  let paramIndex = 0
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (ch === '\'') {
      // Toggle string state, accounting for the doubled-quote escape.
      if (inString && sql[i + 1] === '\'') {
        out += '\'\''
        i++
        continue
      }
      inString = !inString
      out += ch
      continue
    }
    if (ch === '?' && !inString) {
      if (paramIndex >= params.length)
        throw new R2SqlError(`SQL has more ? placeholders than params (${params.length})`)
      out += escapeSqlValue(params[paramIndex++])
      continue
    }
    out += ch
  }
  if (paramIndex !== params.length)
    throw new R2SqlError(`SQL has ${paramIndex} ? placeholders but ${params.length} params supplied`)
  return out
}

/** The CF API envelope R2 SQL returns. */
interface CfEnvelope {
  success: boolean
  errors?: { code?: number, message: string }[]
  result?: {
    // R2 SQL returns either a `rows` array of objects, or a
    // columns + data shape. Support both.
    rows?: R2SqlRow[]
    columns?: string[]
    data?: (string | number | null)[][]
  }
}

function normalizeRows(result: CfEnvelope['result']): R2SqlRow[] {
  if (!result)
    return []
  if (Array.isArray(result.rows))
    return result.rows
  if (Array.isArray(result.columns) && Array.isArray(result.data)) {
    const cols = result.columns
    return result.data.map((tuple) => {
      const row: R2SqlRow = {}
      cols.forEach((col, idx) => {
        row[col] = tuple[idx] ?? null
      })
      return row
    })
  }
  return []
}

/** A configured R2 SQL client. */
export interface R2SqlClient {
  /** Run a raw SQL string (table reference already resolved). */
  query: (sql: string) => Promise<R2SqlResult>
  /** Run a dialect-neutral plan: resolve `{{TABLE}}`, inline params, send. */
  runPlan: (plan: ArchetypeSqlPlan) => Promise<R2SqlResult>
  /** Translate + run an archetype query end to end. */
  runArchetype: (query: ArchetypeQuery) => Promise<R2SqlResult>
}

/**
 * Create an R2 SQL client. The endpoint requires a real CF token in
 * production; tests inject `fetchImpl` returning a recorded envelope.
 */
export function createR2SqlClient(config: R2SqlClientConfig): R2SqlClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  const apiBase = config.apiBase ?? DEFAULT_API_BASE
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const endpoint = `${apiBase}/accounts/${config.accountId}/r2-sql/query/${config.bucket}`

  async function query(sql: string): Promise<R2SqlResult> {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new R2SqlTimeoutError(timeoutMs)), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${config.token}`,
          'content-type': 'application/json',
          'user-agent': 'gscdump-cloudflare-r2sql/1.0',
        },
        body: JSON.stringify({ query: sql }),
        signal: controller.signal,
      })
    }
    catch (err) {
      if (err instanceof R2SqlTimeoutError || (err as Error)?.name === 'AbortError')
        throw new R2SqlTimeoutError(timeoutMs)
      throw new R2SqlError(`R2 SQL request failed: ${(err as Error).message}`)
    }
    finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new R2SqlError(`R2 SQL HTTP ${response.status}: ${text}`, response.status)
    }
    const envelope = (await response.json()) as CfEnvelope
    if (!envelope.success) {
      const msg = envelope.errors?.map(e => e.message).join('; ') ?? 'unknown R2 SQL error'
      throw new R2SqlError(`R2 SQL query rejected: ${msg}`)
    }
    return {
      rows: normalizeRows(envelope.result),
      sql,
      queryMs: Date.now() - started,
    }
  }

  function runPlan(plan: ArchetypeSqlPlan): Promise<R2SqlResult> {
    const tableRef = r2TableRef(config.namespace, plan.table)
    const resolved = plan.sql.split(TABLE_PLACEHOLDER).join(tableRef)
    return query(workaroundPartitionEquality(inlineParams(resolved, plan.params)))
  }

  function runArchetype(archetypeQuery: ArchetypeQuery): Promise<R2SqlResult> {
    return runPlan(buildArchetypeSql(archetypeQuery))
  }

  return { query, runPlan, runArchetype }
}
