/**
 * DuckDB SQL analyzer collection. Pure array export — no side effects.
 *
 * Derived from `ALL_ANALYZERS`: every `DefinedAnalyzer` with a `sql` variant
 * is included automatically. Pass to
 * `createAnalyzerRegistry({ sql: SQL_ANALYZERS })` for narrow composition,
 * or prefer `createAnalyzerRegistry({ defined: ALL_ANALYZERS })` in-tree.
 */

import type { Analyzer } from '@gscdump/engine/analyzer'

import { ALL_ANALYZERS } from './analyzer/all'

export const SQL_ANALYZERS: readonly Analyzer[] = ALL_ANALYZERS.flatMap(
  d => (d.sql ? [d.sql] : []),
)
