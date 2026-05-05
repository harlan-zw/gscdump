/**
 * Default report registry. Phase 2: `health` + `movers`. More follow.
 * Consumers compose their own via `createReportRegistry({...})`.
 */

import type { DefinedReport, ReportParams } from '@gscdump/engine/report'
import { createReportRegistry } from '@gscdump/engine/report'
import { brandReport } from './reports/brand'
import { growthReport } from './reports/growth'
import { healthReport } from './reports/health'
import { moversReport } from './reports/movers'
import { opportunitiesReport } from './reports/opportunities'
import { prePublishReport } from './reports/pre-publish'
import { priorityReport } from './reports/priority'
import { risksReport } from './reports/risks'
import { triageReport } from './reports/triage'

export const REPORTS: readonly DefinedReport<ReportParams>[] = [
  brandReport as unknown as DefinedReport<ReportParams>,
  growthReport as unknown as DefinedReport<ReportParams>,
  healthReport as unknown as DefinedReport<ReportParams>,
  moversReport as unknown as DefinedReport<ReportParams>,
  opportunitiesReport as unknown as DefinedReport<ReportParams>,
  prePublishReport as unknown as DefinedReport<ReportParams>,
  priorityReport as unknown as DefinedReport<ReportParams>,
  risksReport as unknown as DefinedReport<ReportParams>,
  triageReport as unknown as DefinedReport<ReportParams>,
]

export const defaultReportRegistry = createReportRegistry({
  reports: REPORTS,
  version: '0',
})
