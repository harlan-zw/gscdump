/**
 * Source-based entrypoint. Thin facade over `analyzer/dispatch`.
 *
 * Registry is explicit: callers compose one via `createAnalyzerRegistry` or
 * import `defaultAnalyzerRegistry` from the top-level `@gscdump/analysis`
 * barrel. Keeping it out of module scope avoids tree-shaking and test
 * isolation foot-guns that come with side-effect registration.
 */

import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AnalyzerRegistry } from '@gscdump/engine/analyzer'
import type { AnalysisQuerySource } from '@gscdump/engine/resolver'

import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'

export { AnalyzerCapabilityError } from '@gscdump/engine/analyzer'

export async function analyzeFromSource(
  source: AnalysisQuerySource,
  params: AnalysisParams,
  registry: AnalyzerRegistry,
): Promise<AnalysisResult> {
  return runAnalyzerFromSource(source, params, registry)
}
