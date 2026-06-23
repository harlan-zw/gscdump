// Translate a structured query filter into a hyparquet row-group pushdown
// filter, conservatively. The pushdown lets the pure-JS parquet decoder prune
// row groups and materialise only matching rows before the executor re-applies
// the full SQL WHERE downstream — so it must never drop a row the final query
// would keep.
//
// Safety model:
// - Only `query`-dimension EQUALITY is translated. `query` is stored verbatim
//   (no write- or read-time normalization — see resolver/filter-utils
//   `matchesDimensionFilter`, which special-cases only `page`), so `query = x`
//   maps to an EXACT parquet predicate. `page`/`url` is deliberately excluded:
//   `toPath` stores pathname-only while the read matcher re-normalizes via
//   `normalizeUrl`, so a pushed equality could drop fallback-encoded URLs.
// - A top-level AND may push the conjuncts that translate and DROP the rest:
//   dropping a conjunct only widens the row set, and the executor's SQL WHERE
//   narrows it back. This is the one place correctness leans on downstream
//   re-filtering; it is always present in the read path that consumes this.
// - A top-level OR (a bare `or(...)` or `inArray(...)`) must translate EXACTLY
//   or not at all: dropping an OR branch would NARROW the result, and the
//   decoder materialises only matches, so there is no downstream recovery.

import type { BuilderState, Filter, InternalFilter } from 'gscdump/query'
import type { ParquetQueryFilter } from 'hyparquet'
import type { TableName } from './storage'
import { SCHEMAS } from './schema'

// Builder dimension -> parquet column, for dimensions whose stored value is the
// filter value verbatim. Keep this map minimal: every entry is a correctness
// claim that the column carries no normalization on either the write or read
// side. `query` qualifies; `page` does not (see file header).
const PUSHABLE_COLUMN: Readonly<Record<string, string>> = { query: 'query' }

function txLeaf(leaf: InternalFilter, columns: ReadonlySet<string>): ParquetQueryFilter | null {
  if (leaf.operator !== 'equals')
    return null
  const column = PUSHABLE_COLUMN[leaf.dimension]
  if (!column || !columns.has(column))
    return null
  return { [column]: { $eq: leaf.expression } }
}

// Exact translation of a filter node, or null if ANY part is untranslatable.
// Exactness is what makes a node safe to drop wholesale: an OR branch that
// can't be translated nulls the whole node rather than silently narrowing.
function txExact(node: Filter<object>, columns: ReadonlySet<string>): ParquetQueryFilter | null {
  const groupType = node._groupType ?? 'and'
  const leafParts: ParquetQueryFilter[] = []
  for (const leaf of node._filters) {
    const t = txLeaf(leaf, columns)
    if (!t)
      return null
    leafParts.push(t)
  }
  if (groupType === 'or') {
    // `or()` forbids nested groups; treat any as untranslatable.
    if (node._nestedGroups?.length || leafParts.length === 0)
      return null
    return leafParts.length === 1 ? leafParts[0] : { $or: leafParts }
  }
  const parts = leafParts
  for (const group of node._nestedGroups ?? []) {
    const t = txExact(group, columns)
    if (!t)
      return null
    parts.push(t)
  }
  if (parts.length === 0)
    return null
  return parts.length === 1 ? parts[0] : { $and: parts }
}

/**
 * Build a parquet pushdown filter from a query's structured filter for `table`,
 * or `undefined` when nothing is safely pushable. Pure; depends only on the
 * filter shape and the table's column set.
 */
export function extractParquetPushdown(
  state: BuilderState | undefined,
  table: TableName,
): ParquetQueryFilter | undefined {
  const filter = state?.filter
  const schema = SCHEMAS[table]
  if (!filter || !schema)
    return undefined
  const columns = new Set(schema.columns.map(c => c.name))

  // A top-level OR is all-or-nothing: dropping a branch narrows the result.
  if ((filter._groupType ?? 'and') === 'or')
    return txExact(filter, columns) ?? undefined

  // Top-level AND: push what translates, drop the rest (widening is safe).
  const parts: ParquetQueryFilter[] = []
  for (const leaf of filter._filters) {
    const t = txLeaf(leaf, columns)
    if (t)
      parts.push(t)
  }
  for (const group of filter._nestedGroups ?? []) {
    const t = txExact(group, columns)
    if (t)
      parts.push(t)
  }
  if (parts.length === 0)
    return undefined
  return parts.length === 1 ? parts[0] : { $and: parts }
}
