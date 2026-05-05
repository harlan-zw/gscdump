/**
 * `@gscdump/analysis/report` — report runtime.
 *
 * `defineReport` lives at `@gscdump/engine/report` (mirrors `defineAnalyzer`).
 * Consumers wanting the public surface import from `@gscdump/analysis` (root).
 */

export { formatReport } from './format'
export type { FormatReportOptions } from './format'
export { defaultReportRegistry, REPORTS } from './registry'
export { resolveTarget } from './resolve-target'
export type { ResolveTargetInput, ResolveTargetKind, ResolveTargetResult } from './resolve-target'
export { dryRunReport, runReport } from './runtime'
export type { DryRunReportResult, RunReportOptions } from './runtime'
