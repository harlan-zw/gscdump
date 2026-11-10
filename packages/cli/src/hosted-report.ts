import type { RunReportV1Data, RunReportV1Request } from '@gscdump/contracts/v1'
import { runReportV1RequestSchema } from '@gscdump/contracts/v1'
import { resolveHostedSite } from './hosted-site'

type HostedReport = Omit<RunReportV1Data, 'meta'> & { meta: RunReportV1Data['meta'] & { requestId: string, source: 'hosted' } }

/** Preserve server-selected windows. A Hosted report never guesses the record's newest complete day. */
export function hostedReportRequest(reportId: string, args: Record<string, unknown>): RunReportV1Request {
  if (args['prev-start'] || args['prev-end'] || args['fetch-budget'])
    throw new Error('Hosted reports do not accept --prev-start, --prev-end, or --fetch-budget. Use --vs for comparison.')
  const period = args.period ? String(args.period).replace(/^(\d+d)$/, 'last-$1') : undefined
  return runReportV1RequestSchema.parse({
    reportId,
    period,
    comparison: args.vs,
    start: args.start,
    end: args.end,
    target: args.target,
    targetKind: args['target-kind'],
    brandTerms: args['brand-terms'],
    topic: args.topic,
    force: Boolean(args.force),
  })
}

export async function runHostedReport(reportId: string, args: Record<string, unknown>): Promise<HostedReport> {
  const body = hostedReportRequest(reportId, args)
  const { client, site } = await resolveHostedSite(args, { name: `report ${reportId}`, localAlternative: 'run the report against your Store' })
  const response = await client.runReport({ params: { siteId: site.siteId }, body })
  return { ...response.data, meta: { ...response.data.meta, requestId: response.meta.requestId, source: 'hosted' } }
}
