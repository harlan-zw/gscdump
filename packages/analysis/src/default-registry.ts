/**
 * Default analyzer registry built from every in-tree analyzer: row analyzers
 * plus DuckDB SQL analyzers. Convenience for callers who don't care about
 * bundle size; edge / browser consumers should compose their own narrower
 * registry via `createAnalyzerRegistry`.
 *
 * Importing this module transitively pulls in `@gscdump/engine-duckdb-node`
 * and its DuckDB SQL builder code.
 */

import { SQL_ANALYZERS } from '@gscdump/engine-duckdb-node'
import { createAnalyzerRegistry } from './analyzer/registry'
import { ROW_ANALYZERS } from './analyzer/row-analyzers'

export const defaultAnalyzerRegistry = createAnalyzerRegistry({
  rows: ROW_ANALYZERS,
  sql: SQL_ANALYZERS,
})
