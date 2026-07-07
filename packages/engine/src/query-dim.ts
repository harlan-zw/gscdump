// Versioned `query → canonical (+ intent)` dimension (ADR-0017 Phase 2 /
// ADR-0019 / ADR-0020). One row per distinct query, derived offline from the
// query string and stamped with the producer versions, so canonical / intent
// can be JOINed at rollup-build or read time instead of baked per fact row —
// and re-canonicalizing is a cheap dimension rebuild, not a fact re-ingest.
//
// The engine stays free of `@gscdump/analysis`: the normalizer + intent
// classifier are INJECTED (`QueryDimDeps`), exactly like `IngestOptions.
// normalizeQuery`. Hosts wire the real functions + their version constants.

import type { TenantCtx } from '@gscdump/contracts'
import type { Row } from './contracts'
import type { ColumnDef } from './schema'
import type { DataSource } from './storage'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse'
import { decodeParquetToRows, encodeRowsToParquetFlex } from './adapters/hyparquet'

export interface QueryDimRecord {
  query: string
  /** Lexical canonical, never empty: NULL/'' folds to the raw query. */
  query_canonical: string
  /** Packed search-intent code (see `@gscdump/analysis` `encodeIntent`). */
  intent_code: number
  normalizer_version: number
  intent_version: number
}

/** JSON sidecar: versions + freshness, readable without decoding the parquet. */
export interface QueryDimMeta {
  version: 1
  builtAt: number
  rowCount: number
  normalizerVersion: number
  intentVersion: number
}

const QUERY_DIM_COLUMNS: readonly ColumnDef[] = [
  { name: 'query', type: 'VARCHAR', nullable: false },
  { name: 'query_canonical', type: 'VARCHAR', nullable: false },
  { name: 'intent_code', type: 'INTEGER', nullable: false },
  { name: 'normalizer_version', type: 'INTEGER', nullable: false },
  { name: 'intent_version', type: 'INTEGER', nullable: false },
]

function queryDimPrefix(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/query_dim`
    : `u_${ctx.userId}/entities/query_dim`
}

export function queryDimParquetKey(ctx: TenantCtx): string {
  return `${queryDimPrefix(ctx)}/index.parquet`
}

export function queryDimMetaKey(ctx: TenantCtx): string {
  return `${queryDimPrefix(ctx)}/index.json`
}

/**
 * Injected derivation. `engine` never imports `@gscdump/analysis`; the host
 * passes `normalizeQuery` / `classifyIntentCode` (e.g. `encodeIntent ∘
 * classifyQueryIntent`) plus their version constants.
 */
export interface QueryDimDeps {
  normalizeQuery: (query: string) => string
  normalizerVersion: number
  /** Returns the packed intent code for a raw query. */
  classifyIntentCode: (query: string) => number
  intentVersion: number
}

/**
 * Pure: distinct raw queries → dimension records. De-dupes, drops empties, and
 * folds an empty/whitespace canonical back to the raw query so the dimension
 * is total for read-time joins.
 */
export function buildQueryDimRecords(queries: Iterable<string>, deps: QueryDimDeps): QueryDimRecord[] {
  const seen = new Set<string>()
  const out: QueryDimRecord[] = []
  for (const raw of queries) {
    const query = String(raw)
    if (query.trim() === '' || seen.has(query))
      continue
    seen.add(query)
    const canonical = deps.normalizeQuery(query)
    out.push({
      query,
      query_canonical: canonical === '' ? query : canonical,
      intent_code: deps.classifyIntentCode(query),
      normalizer_version: deps.normalizerVersion,
      intent_version: deps.intentVersion,
    })
  }
  return out
}

export interface QueryDimStore {
  parquetKey: (ctx: TenantCtx) => string
  /** Write the parquet + JSON sidecar. Last-write-wins; no history. */
  write: (ctx: TenantCtx, records: readonly QueryDimRecord[], builtAt: number) => Promise<{ parquetKey: string, rowCount: number }>
  /** Read the sidecar (versions + freshness), or null on first build. */
  loadMeta: (ctx: TenantCtx) => Promise<QueryDimMeta | null>
  /** Decode the dimension rows (test/inspection; reads JOIN the parquet by key). */
  loadRecords: (ctx: TenantCtx) => Promise<QueryDimRecord[]>
}

export function createQueryDimStore({ dataSource }: { dataSource: DataSource }): QueryDimStore {
  async function exists(key: string, prefix: string): Promise<boolean> {
    // `read` rejects on a missing key (an absent dimension is an expected
    // first-build state, not a failure), so probe via prefix LIST instead.
    const keys = await dataSource.list(prefix)
    return keys.includes(key)
  }

  return {
    parquetKey: queryDimParquetKey,

    async write(ctx, records, builtAt) {
      const parquetKey = queryDimParquetKey(ctx)
      const bytes = encodeRowsToParquetFlex(records as unknown as readonly Row[], { columns: QUERY_DIM_COLUMNS, sortKey: ['query'] })
      await dataSource.write(parquetKey, bytes)
      const meta: QueryDimMeta = {
        version: 1,
        builtAt,
        rowCount: records.length,
        normalizerVersion: records[0]?.normalizer_version ?? 0,
        intentVersion: records[0]?.intent_version ?? 0,
      }
      await dataSource.write(queryDimMetaKey(ctx), encodeJsonBigintSafe(meta))
      return { parquetKey, rowCount: records.length }
    },

    async loadMeta(ctx) {
      const key = queryDimMetaKey(ctx)
      if (!(await exists(key, `${queryDimPrefix(ctx)}/`)))
        return null
      const bytes = await dataSource.read(key)
      return JSON.parse(new TextDecoder().decode(bytes)) as QueryDimMeta
    },

    async loadRecords(ctx) {
      const key = queryDimParquetKey(ctx)
      if (!(await exists(key, `${queryDimPrefix(ctx)}/`)))
        return []
      const rows = await decodeParquetToRows(await dataSource.read(key))
      return rows.map(r => ({
        query: String(r.query),
        query_canonical: String(r.query_canonical),
        intent_code: Number(r.intent_code),
        normalizer_version: Number(r.normalizer_version),
        intent_version: Number(r.intent_version),
      }))
    },
  }
}
