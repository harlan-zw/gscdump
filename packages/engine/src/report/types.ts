/**
 * Reports — composition layer above analyzers.
 *
 * A report runs N analyzer steps (`ReportPlanStep`) in parallel and reduces
 * their `AnalysisResult`s into structured `ReportSection`s with bounded
 * findings + agent-actionable next steps. Same registry pattern as analyzers,
 * same status vocab as `ActionPrioritySourceState`.
 *
 * Pure types only. Runtime lives in `@gscdump/analysis/report`.
 */

import type { AnalysisParams, AnalysisResult } from '../analysis-types'
import type { ComparisonMode, ResolvedWindow, WindowPreset } from '../period'

/** Status vocabulary mirrors `ActionPrioritySourceStatus`. */
export type ReportStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

/**
 * `unknown` is not a rung on the info→high ladder: it means the section's
 * backing analyzer(s) failed, so no severity could be assessed. The report
 * runtime is the only writer — a report's `reduce` never returns it. See
 * `ReportPlanStep.feeds`.
 */
export type ReportSeverity = 'info' | 'low' | 'medium' | 'high' | 'unknown'

export type ReportEntityKind = 'page' | 'query'

export type ReportActionKind = 'analyzer' | 'cli' | 'indexing' | 'fix'

export type ReportCoverage = 'full' | 'partial'

/** Citty-shaped arg spec, kept structural so engine doesn't pull citty in. */
export interface ReportArgDef {
  type: 'string' | 'boolean' | 'number'
  description?: string
  default?: string | boolean | number
  required?: boolean
  alias?: string
}
export type ReportArgsSpec = Record<string, ReportArgDef>

export interface ReportEntity {
  kind: ReportEntityKind
  value: string
}

export interface ReportFindingDelta {
  metric: string
  prior: number
  current: number
  pct: number
}

export interface ReportFinding {
  entity: ReportEntity
  metrics: Record<string, number>
  delta?: ReportFindingDelta
  why?: string
}

export interface ReportSectionSummary {
  delta?: number
  direction?: 'up' | 'down' | 'flat'
  magnitudeLabel?: string
}

export interface ReportAction {
  kind: ReportActionKind
  target?: ReportEntity
  params?: Record<string, unknown>
  rationale: string
  /** Human hint, generated; never authoritative. */
  cliHint?: string
}

export interface ReportSectionArtifact {
  analyzer: string
  params: AnalysisParams
}

export interface ReportSection {
  id: string
  title: string
  severity: ReportSeverity
  summary: ReportSectionSummary
  /** Bounded; sorted by stable composite key. */
  findings: ReportFinding[]
  truncated?: { kept: number, total: number }
  coverage: ReportCoverage
  actions: ReportAction[]
  artifact?: ReportSectionArtifact
}

export interface ReportPlanStep {
  /** Stable identifier within the report (e.g. `movers`, `decay-current`). */
  key: string
  /** Analyzer id (or future: nested report id). Open string by design. */
  type: string
  /** Analyzer params; report-runtime applies `type` from the step. */
  params: Omit<AnalysisParams, 'type'>
  /** Required steps fail the report; optional steps degrade `coverage`. */
  required?: boolean
  /**
   * Ids of the `ReportSection`s this step's result feeds. Defaults to
   * `[key]`, which is the common case (section id === step key).
   *
   * This is what lets the runtime tell "the analyzer failed" apart from "the
   * analyzer returned zero rows": a section whose feeding steps ALL errored
   * carries no information, and the runtime replaces it with an explicit
   * `severity: 'unknown'` shape instead of letting `reduce` publish
   * aggregates computed over an empty array. A section fed by a mix of
   * failed and successful steps still has real content and is left alone
   * (its `coverage` stays `partial`).
   *
   * Declare it whenever a section id differs from the step key, or a step
   * feeds several sections. `report-unavailable.test.ts` fails on any
   * emitted section no step claims.
   */
  feeds?: readonly string[]
}

export interface ReportStepStateMeta {
  key: string
  type: string
  status: ReportStepStatus
  error?: string
}

export interface ReportResultMeta {
  durationMs: number
  rowsScanned: number
  degraded: boolean
  steps: ReportStepStateMeta[]
}

export interface ReportResult {
  id: string
  site: string
  /** sha256(id|site|window|paramsCanonical|registryVersion). Stable. */
  inputHash: string
  /** ISO 8601. NOT included in inputHash. */
  generatedAt: string
  window: ResolvedWindow
  sections: ReportSection[]
  meta: ReportResultMeta
}

/**
 * Loose params bag. Concrete reports refine this with their own interface.
 * Constraint is `object` so report authors can use plain interfaces without
 * needing an index signature.
 */
export type ReportParams = object

export interface ReportContext<P extends ReportParams = ReportParams> {
  /** Resolved site URL (e.g. `https://example.com/`). */
  site: string
  /** Already-resolved window — runtime calls `resolveWindow` once before plan(). */
  window: ResolvedWindow
  params: P
  /** Hash of registry/code version. Bumped via package version. */
  registryVersion: string
}

/**
 * Reduce step results → sections. Runtime injects `meta` post-reduce.
 */
export type ReportReducer<P extends ReportParams = ReportParams>
  = (results: Record<string, AnalysisResult>, ctx: ReportContext<P>) => Omit<ReportResult, 'meta' | 'inputHash' | 'generatedAt' | 'site' | 'window' | 'id'> & { sections: ReportSection[] }

export interface DefinedReport<P extends ReportParams = ReportParams> {
  id: string
  description: string
  defaultPeriod: WindowPreset
  defaultComparison: ComparisonMode
  /** Single source of truth for CLI flags + MCP input schema. */
  argsSpec: ReportArgsSpec
  plan: (params: P, window: ResolvedWindow) => readonly ReportPlanStep[]
  reduce: ReportReducer<P>
}

export interface DefineReportOptions<P extends ReportParams = ReportParams> {
  id: string
  description: string
  defaultPeriod: WindowPreset
  defaultComparison: ComparisonMode
  argsSpec?: ReportArgsSpec
  plan: (params: P, window: ResolvedWindow) => readonly ReportPlanStep[]
  reduce: ReportReducer<P>
}
