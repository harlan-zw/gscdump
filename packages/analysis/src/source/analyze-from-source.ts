/**
 * Source-based entrypoint. Thin facade over `analyzer/dispatch`.
 *
 * Registry is explicit: callers compose one via `createAnalyzerRegistry` or
 * import `defaultAnalyzerRegistry` from the top-level `@gscdump/analysis`
 * barrel. Keeping it out of module scope avoids tree-shaking and test
 * isolation foot-guns that come with side-effect registration.
 */

import type { AnalyzerRegistry } from '../analyzer/registry'
import type { AnalysisParams, AnalysisResult } from '../types'
import type { AnalysisQuerySource } from './types'

import { runAnalyzerFromSource } from '../analyzer/dispatch'

export { AnalyzerCapabilityError } from '../analyzer/dispatch'

export async function analyzeFromSource(
  source: AnalysisQuerySource,
  params: AnalysisParams,
  registry: AnalyzerRegistry,
): Promise<AnalysisResult> {
  return runAnalyzerFromSource(source, params, registry)
}
