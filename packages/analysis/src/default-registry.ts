/**
 * Default analyzer registry built from every in-tree analyzer: row analyzers
 * plus DuckDB SQL analyzers. Convenience for callers who don't care about
 * bundle size; edge / browser consumers should compose their own narrower
 * registry via `createAnalyzerRegistry`.
 */

import { createAnalyzerRegistry } from '@gscdump/engine/analyzer'
import { ROW_ANALYZERS } from './analyzer/row-analyzers'
import { SQL_ANALYZERS } from './sql-analyzers'

export const defaultAnalyzerRegistry = createAnalyzerRegistry({
  rows: ROW_ANALYZERS,
  sql: SQL_ANALYZERS,
})
