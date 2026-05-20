// Arrow IPC encoder for the DUCKDB_SVC transport.
//
// The main Worker decodes parquet to JS rows (hyparquet), merges the files
// behind one `read_parquet({{NAME}})` placeholder, then encodes the merged
// rows here into an Arrow IPC *stream* buffer. The duckdb sibling Worker
// ingests that buffer directly via `insertArrowFromIPCStream` — no row→column
// rebuild, no structured-clone of millions of JS row objects across the
// service binding.
//
// Two inference rules are load-bearing and must never regress:
//  - every string column is encoded as plain `utf8()`. flechette's value
//    inference would pick `dictionary(utf8())`, which `insertArrowFromIPCStream`
//    rejects (the IPC stream must not carry dictionary-encoded columns).
//  - an all-null column is encoded as `utf8()`. flechette would infer
//    `nullType()`, which lands as a DuckDB NULL-typed column and breaks every
//    downstream CAST/comparison the query SQL performs.

import type { ColumnDef, Row } from '@gscdump/engine'
import { float64, int32, int64, tableFromArrays, tableToIPC, utf8 } from '@uwdata/flechette'

type ArrowType = ReturnType<typeof utf8 | typeof int32 | typeof int64 | typeof float64>

// Engine column types → Arrow types. `DATE` maps to `utf8()` because the
// fact-table encoder stores dates as ISO strings (see engine hyparquet adapter);
// mapping to a real Arrow date would mis-handle the string values.
function arrowTypeForColumn(type: ColumnDef['type']): ArrowType {
  switch (type) {
    case 'VARCHAR':
    case 'DATE':
      return utf8()
    case 'BIGINT':
      return int64()
    case 'INTEGER':
      return int32()
    case 'DOUBLE':
      return float64()
  }
}

/**
 * Encode merged rows into an Arrow IPC stream buffer for transport over the
 * `DUCKDB_SVC` service binding.
 *
 * `schemaColumns` (when the placeholder maps to a known fact table) makes
 * every fact column authoritatively typed; columns absent from the schema
 * (entity-sidecar parquets, whose `placeholderTables` entry deliberately
 * lies about the table) fall back to value inference.
 *
 * The output column set is the *union* of `schemaColumns` and every key seen
 * across all rows — a coarse tier file may carry a column an older file lacks,
 * and building from `rows[0]` alone would silently drop it.
 */
export function rowsToArrowIPC(rows: Row[], schemaColumns?: readonly ColumnDef[]): Uint8Array {
  const colNames: string[] = []
  const seen = new Set<string>()
  const add = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name)
      colNames.push(name)
    }
  }
  if (schemaColumns) {
    for (const c of schemaColumns)
      add(c.name)
  }
  for (const row of rows) {
    for (const key in row)
      add(key)
  }

  const schemaType = new Map<string, ColumnDef['type']>()
  if (schemaColumns) {
    for (const c of schemaColumns)
      schemaType.set(c.name, c.type)
  }

  const data: Record<string, unknown[]> = {}
  const types: Record<string, ArrowType> = {}
  for (const name of colNames) {
    const values = rows.map(r => r[name] ?? null)
    data[name] = values

    const known = schemaType.get(name)
    if (known) {
      types[name] = arrowTypeForColumn(known)
      continue
    }
    // Value inference for non-schema columns. Force `utf8()` whenever a string
    // value appears or the column is entirely null — see the rules in the file
    // header. Purely-numeric columns are left untyped so flechette picks the
    // narrowest int/float, matching the previous duckdb-worker behaviour.
    let hasString = false
    let hasValue = false
    for (const v of values) {
      if (v === null || v === undefined)
        continue
      hasValue = true
      if (typeof v === 'string') {
        hasString = true
        break
      }
    }
    if (hasString || !hasValue)
      types[name] = utf8()
  }

  const table = tableFromArrays(data, { types })
  const ipc = tableToIPC(table, { format: 'stream' })
  if (!ipc)
    throw new Error('rowsToArrowIPC: tableToIPC returned null')
  return ipc
}
