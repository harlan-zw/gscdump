/**
 * `@gscdump/engine/report` — report contracts + factory + registry.
 *
 * Mirrors `@gscdump/engine/analyzer`: pure types here, runtime in
 * `@gscdump/analysis/report`.
 */

export { defineReport } from './define'
export { canonicalize, computeInputHash } from './hash'
export type { InputHashSeeds } from './hash'
export { createReportRegistry } from './registry'
export type { ReportRegistry, ReportRegistryInit } from './registry'
export type {
  DefinedReport,
  DefineReportOptions,
  ReportArgDef,
  ReportArgsSpec,
  ReportContext,
  ReportCoverage,
  ReportEntity,
  ReportEntityKind,
  ReportFinding,
  ReportFindingDelta,
  ReportParams,
  ReportPlanStep,
  ReportReducer,
  ReportResult,
  ReportResultMeta,
  ReportSection,
  ReportSectionArtifact,
  ReportSectionSummary,
  ReportSeverity,
  ReportStepStateMeta,
  ReportStepStatus,
} from './types'
