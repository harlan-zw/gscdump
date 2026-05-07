/**
 * Row-based analyzer collection. Pure JS — portable across any
 * `AnalysisQuerySource` that yields rows (live GSC API, in-memory, SQL
 * engines via their row path).
 *
 * Derived from `ALL_ANALYZERS`: every `DefinedAnalyzer` with a `rows` variant
 * is included automatically. Pass to
 * `createAnalyzerRegistry({ rows: ROW_ANALYZERS })` for narrow composition,
 * or prefer `createAnalyzerRegistry({ defined: ALL_ANALYZERS })` in-tree.
 */

import type { Analyzer } from '@gscdump/engine/analyzer'

import { ALL_ANALYZERS } from './all'

export const ROW_ANALYZERS: readonly Analyzer[] = ALL_ANALYZERS.flatMap(
  d => (d.rows ? [d.rows] : []),
)
