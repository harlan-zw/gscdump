/**
 * Run analyzers against an already-attached DuckDB database (schema-per-table,
 * as produced by `gscdump store export`). Wraps the runner in an
 * `AnalysisQuerySource` with the `attachedTables` capability and dispatches
 * via the unified analyzer pipeline.
 *
 * The registry is an explicit parameter: browser/edge consumers should compose
 * a narrow registry instead of pulling in `defaultAnalyzerRegistry` (which
 * statically imports every SQL analyzer).
 */

import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AnalyzerRegistry } from '@gscdump/engine/analyzer'
import type { AttachedTableRunner, AttachedTableSourceOptions } from '@gscdump/engine/source'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { pgResolverAdapter } from '@gscdump/engine/resolver'
import { createAttachedTableSource } from '@gscdump/engine/source'

export type { AnalyzerRegistry } from '@gscdump/engine/analyzer'
export type { AttachedTableRunner as AnalyzerRunner, AttachedTableSourceOptions as BrowserAnalyzeOptions } from '@gscdump/engine/source'

export async function analyzeInBrowser(
  runner: AttachedTableRunner,
  opts: AttachedTableSourceOptions,
  params: AnalysisParams,
  registry: AnalyzerRegistry,
): Promise<AnalysisResult> {
  opts.signal?.throwIfAborted()
  const source = createAttachedTableSource(runner, { adapter: pgResolverAdapter, ...opts })
  return runAnalyzerFromSource(source, params, registry)
}
