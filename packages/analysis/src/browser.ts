/**
 * Run analyzers against an already-attached DuckDB database (schema-per-table,
 * as produced by `gscdump store export`). Wraps the runner in an
 * `AnalysisQuerySource` with the `attachedTables` capability and dispatches
 * via the unified analyzer pipeline.
 */

import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AttachedTableRunner, AttachedTableSourceOptions } from '@gscdump/engine/source'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createAttachedTableSource } from '@gscdump/engine/source'
import { defaultAnalyzerRegistry } from './default-registry'

export type { AttachedTableRunner as AnalyzerRunner, AttachedTableSourceOptions as BrowserAnalyzeOptions } from '@gscdump/engine/source'
export { rewriteForTableSource } from '@gscdump/engine/source'

export async function analyzeInBrowser(
  runner: AttachedTableRunner,
  opts: AttachedTableSourceOptions,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  opts.signal?.throwIfAborted()
  const source = createAttachedTableSource(runner, opts)
  return runAnalyzerFromSource(source, params, defaultAnalyzerRegistry)
}
