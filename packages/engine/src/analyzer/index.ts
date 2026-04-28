/**
 * `@gscdump/engine/analyzer` — analyzer contracts + dispatcher.
 *
 * Contains the `Analyzer` interface, `defineAnalyzer` factory,
 * `runAnalyzerFromSource` dispatcher, and `createAnalyzerRegistry` lookup.
 * Analyzer instances themselves live in `@gscdump/analysis`.
 */

export { defineAnalyzer } from './define'
export type { DefineAnalyzerOptions, DefinedAnalyzer, ReduceCtx, Reducer, SqlPlanSpec } from './define'
export { AnalyzerCapabilityError, runAnalyzerFromSource } from './dispatch'
export { createAnalyzerRegistry } from './registry'
export type { AnalyzerRegistry, AnalyzerRegistryInit, AnalyzerVariants } from './registry'
export type {
  Analyzer,
  Capability,
  Plan,
  ReduceContext,
  RowQueriesPlan,
  SqlExtraQuery,
  SqlPlan,
  TypedRowQuery,
} from './types'
