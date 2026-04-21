/**
 * Shared types + helpers used by every analyzer in `analyzers/*`. The
 * surface is intentionally small: keep cross-cutting concerns here, and
 * put per-analyzer constants/helpers in the analyzer file that owns them.
 */

import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'
import type { Row, StorageEngine, TableName, TenantCtx } from '@gscdump/engine/contracts'

export type { Row, StorageEngine, TableName, TenantCtx }
export type { AnalysisParams, AnalysisResult }

export class AnalyzerUnsupportedError extends Error {
  constructor(tool: string) {
    super(`analyzer "${tool}" is not supported by the DuckDB backend`)
    this.name = 'AnalyzerUnsupportedError'
  }
}

export interface DuckDBAnalyzeDeps {
  engine: StorageEngine
}

export interface FileSet {
  table: TableName
  partitions: string[]
}

export interface ExtraQuerySpec {
  /** Key the shape function uses to look up the result rows. */
  name: string
  sql: string
  params: unknown[]
}

export interface AnalyzerSpec {
  sql: string
  params: unknown[]
  current: FileSet
  previous?: FileSet
  /**
   * Additional named fileSets for analyzers that read from multiple tables in
   * a single SQL statement (e.g. dark-traffic joins `pages`, `keywords`, and
   * `page_keywords`). Keys become placeholders: `FILES_<KEY>` in SQL.
   * Browser rewrite resolves them to `<schema>.<table>`.
   */
  extraFiles?: Record<string, FileSet>
  /**
   * Additional SQL statements run after the primary. Result rows are keyed by
   * `name` and passed to `shape` via the `extras` argument. Used for
   * data-query / data-detail where count + totals + canonical-extras come
   * from separate queries.
   */
  extraQueries?: ExtraQuerySpec[]
  /**
   * Marks analyzers that emit SQL with direct table references (e.g. `pages`,
   * `keywords`) instead of `{{FILES}}` placeholders. `analyzeWithDuckDB`
   * substitutes `{{FILES}}` against the manifest, so these specs can only run
   * against a runner that has the tables attached as views (the browser
   * runtime). The server/manifest path throws `AnalyzerUnsupportedError`.
   */
  requiresAttachedTables?: boolean
  shape: (
    rows: Row[],
    params: AnalysisParams,
    extras?: Record<string, Row[]>,
  ) => { results: Row[], meta: Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// Date helpers — defaults match GSC's typical 3-day reporting lag.
// ---------------------------------------------------------------------------

export function DEFAULT_END(): string {
  return new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]!
}

function DEFAULT_START(): string {
  return new Date(Date.now() - 31 * 86400000).toISOString().split('T')[0]!
}

export function period(params: AnalysisParams): { startDate: string, endDate: string } {
  return {
    startDate: params.startDate || DEFAULT_START(),
    endDate: params.endDate || DEFAULT_END(),
  }
}

export function previous(params: AnalysisParams): { startDate: string, endDate: string } {
  if (!params.prevStartDate || !params.prevEndDate)
    throw new Error(`${params.type} analysis requires prevStartDate and prevEndDate`)
  return { startDate: params.prevStartDate, endDate: params.prevEndDate }
}

// ---------------------------------------------------------------------------
// Row coercion helpers — DuckDB returns BIGINT/JSON in places JavaScript
// doesn't, so every shape function normalizes through these.
// ---------------------------------------------------------------------------

export function num(v: unknown): number {
  if (typeof v === 'number')
    return v
  if (typeof v === 'bigint')
    return Number(v)
  if (v == null)
    return 0
  return Number(v)
}

export function str(v: unknown): string {
  return v == null ? '' : String(v)
}

export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === 'true'
}

export function parseJsonList(v: unknown): Row[] {
  if (Array.isArray(v))
    return v as Row[]
  if (typeof v === 'string' && v.length > 0) {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  }
  return []
}

export function escapeRegexAlt(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
