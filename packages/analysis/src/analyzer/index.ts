/**
 * Analyzer contracts. Engine adapter packages import from here to build
 * Analyzer instances that dispatch via `runAnalyzerFromSource`.
 */

export { strikingDistanceAnalyzer } from '../analyzers/striking-distance'
export type { StrikingDistanceInputRow, StrikingDistanceResult } from '../analyzers/striking-distance'
export { defineAnalyzer } from './define'
export type { DefineAnalyzerOptions, DefinedAnalyzer, SqlPlanSpec } from './define'
export { AnalyzerCapabilityError, runAnalyzerFromSource } from './dispatch'
export { createAnalyzerRegistry } from './registry'
export type { AnalyzerRegistry, AnalyzerRegistryInit, AnalyzerVariants } from './registry'
export { ROW_ANALYZERS } from './row-analyzers'
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
export type { FileSet } from '@gscdump/engine/resolver'
