/**
 * Drift guard for dialect drizzle schemas vs the canonical `SCHEMAS`
 * manifest in `gscdump/analytics/schema`. SCHEMAS is the single source of
 * truth for GSC-derived columns (url, query, date, metrics). Dialect
 * schemas may add extras (site_id, created_at, prefix). The guard ensures
 * every canonical column is present.
 *
 * - `mode: 'exact'` (pg/wasm parquet): dialect columns must equal SCHEMAS.
 * - `mode: 'superset'` (sqlite/D1): dialect columns must include SCHEMAS.
 */

import type { TableName } from '@gscdump/contracts'
import { SCHEMAS } from '../schema'

export interface AssertSchemaInSyncOptions {
  /** Label used in the thrown error (e.g. 'browser', 'sqlite'). */
  label: string
  /** Drizzle schema keyed by table name. For sqlite, strip the `gsc_` prefix before passing. */
  schema: Record<string, unknown>
  /**
   * Map drizzle table key → canonical `TableName`. For browser this is identity;
   * for sqlite this strips the `gsc_` prefix.
   */
  tableKeyToName: (key: string) => TableName
  mode: 'exact' | 'superset'
}

export function assertSchemaInSync(options: AssertSchemaInSyncOptions): void {
  const { label, schema, tableKeyToName, mode } = options
  for (const [key, table] of Object.entries(schema)) {
    const tableName = tableKeyToName(key)
    const sourceCols = SCHEMAS[tableName].columns.map(c => c.name).sort()
    const drizzleCols = Object.keys((table as Record<symbol, unknown>)[Symbol.for('drizzle:Columns')] as Record<string, unknown> ?? {}).sort()
    const missing = sourceCols.filter(c => !drizzleCols.includes(c))
    const extra = mode === 'exact' ? drizzleCols.filter(c => !sourceCols.includes(c)) : []
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `${label} drizzle schema for '${key}' drifted from SCHEMAS. Missing: [${missing.join(', ')}]. Extra: [${extra.join(', ')}].`,
      )
    }
  }
}
