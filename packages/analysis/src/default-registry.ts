/**
 * Default analyzer registry built from every in-tree analyzer. Convenience
 * for callers who don't care about bundle size; edge / browser consumers
 * should compose their own narrower registry via `createAnalyzerRegistry`
 * with the flat `ROW_ANALYZERS` / `SQL_ANALYZERS` arrays.
 */

import { createAnalyzerRegistry } from '@gscdump/engine/analyzer'
import { ALL_ANALYZERS } from './analyzer/all'

export { ROW_ANALYZERS } from './analyzer/row-analyzers'
export { SQL_ANALYZERS } from './sql-analyzers'

export const defaultAnalyzerRegistry = createAnalyzerRegistry({
  defined: ALL_ANALYZERS,
})
