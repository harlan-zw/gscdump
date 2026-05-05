/**
 * Report registry — pure value, no global state. Mirrors
 * `createAnalyzerRegistry`.
 */

import type { DefinedReport, ReportParams } from './types'

export interface ReportRegistryInit {
  reports?: readonly DefinedReport<ReportParams>[]
  /**
   * Opaque version string. Used as the `registryVersion` input to
   * `inputHash` so cached results invalidate when report code ships.
   * Caller is expected to feed in their package version.
   */
  version?: string
}

export interface ReportRegistry {
  version: string
  listReportIds: () => readonly string[]
  getReport: (id: string) => DefinedReport<ReportParams> | undefined
  listReports: () => readonly DefinedReport<ReportParams>[]
}

export function createReportRegistry(init: ReportRegistryInit = {}): ReportRegistry {
  const byId = new Map<string, DefinedReport<ReportParams>>()
  for (const r of init.reports ?? []) {
    if (byId.has(r.id))
      throw new Error(`createReportRegistry: duplicate report id ${r.id}`)
    byId.set(r.id, r)
  }

  return {
    version: init.version ?? '0',
    listReportIds: () => [...byId.keys()].sort(),
    getReport: (id: string) => byId.get(id),
    listReports: () => [...byId.values()],
  }
}
