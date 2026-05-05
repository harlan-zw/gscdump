import type {
  DefinedReport,
  DefineReportOptions,
  ReportParams,
} from './types'

/**
 * Mirror of `defineAnalyzer`. Pure factory: validates required fields,
 * fills default `argsSpec`. No runtime behaviour — `runReport` consumes
 * the returned object.
 */
export function defineReport<P extends ReportParams = ReportParams>(
  opts: DefineReportOptions<P>,
): DefinedReport<P> {
  if (!opts.id)
    throw new Error('defineReport: id is required')
  if (!opts.plan)
    throw new Error(`defineReport(${opts.id}): plan is required`)
  if (!opts.reduce)
    throw new Error(`defineReport(${opts.id}): reduce is required`)

  return {
    id: opts.id,
    description: opts.description,
    defaultPeriod: opts.defaultPeriod,
    defaultComparison: opts.defaultComparison,
    argsSpec: opts.argsSpec ?? {},
    plan: opts.plan,
    reduce: opts.reduce,
  }
}
