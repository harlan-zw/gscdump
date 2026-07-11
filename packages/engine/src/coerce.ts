/**
 * Canonical BigInt → number coercion for rows crossing the query boundary.
 *
 * DuckDB returns BIGINT for `SUM`/`COUNT` over integer columns; the RPC and
 * JSON boundaries can't carry BigInt (JSON.stringify throws, structured clone
 * across a Worker delivers it but downstream code rarely handles it). Every
 * adapter ends up re-implementing the same coercion — centralize here.
 *
 * Precision loss above 2^53 is acceptable for analytics aggregates: individual
 * click/impression columns never reach that range.
 */

import type { Row } from '@gscdump/contracts'
import { coerceBigIntToNumber } from '@gscdump/lakehouse'

export function coerceRow(row: Row): Row {
  let mutated: Row | null = null
  for (const k in row) {
    if (!Object.hasOwn(row, k))
      continue
    const v = row[k]
    if (typeof v === 'bigint') {
      if (!mutated)
        mutated = { ...row }
      mutated[k] = coerceBigIntToNumber(v) as number
    }
  }
  return mutated ?? row
}

export function coerceRows(rows: readonly Row[]): Row[] {
  const out: Row[] = Array.from({ length: rows.length })
  for (let i = 0; i < rows.length; i++)
    out[i] = coerceRow(rows[i]!)
  return out
}
