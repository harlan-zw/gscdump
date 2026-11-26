import { defineCommand } from 'citty'
import { HOSTED_ARGS, resolveHostedSiteWithTarget } from '../hosted-site'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { commandLineError } from '../stop'
import { applyOutputMode, logger, OUTPUT_ARGS, parseIntegerOption } from '../utils'

const LOCAL_ALTERNATIVE = 'run `gscdump inspect --site <site>` and read saved results with `gscdump entities`'

export const indexingDiagnosticsCommand = defineCommand({
  meta: {
    name: 'diagnostics',
    description: 'Read indexing issue groups and optional sample URLs from stored URL Inspection verdicts (hosted)',
  },
  args: {
    'target': { type: 'positional', required: false, description: 'Site URL or Site ID (or pass --site)' },
    ...HOSTED_ARGS,
    'sample-issues': { type: 'string', description: 'Comma-separated issue types to include sample URLs for' },
    'sample-limit': { type: 'string', description: 'Max sample URLs per issue (1 to 25)' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const sampleLimit = parseIntegerOption(args['sample-limit'], '--sample-limit')
    if (sampleLimit !== undefined && (sampleLimit < 1 || sampleLimit > 25))
      throw commandLineError('--sample-limit must be between 1 and 25.')
    const sampleIssues = args['sample-issues']
      ? String(args['sample-issues']).split(',').map(item => item.trim()).filter(Boolean)
      : undefined

    const { client, site } = await resolveHostedSiteWithTarget(
      args as Record<string, unknown>,
      { name: 'indexing diagnostics', localAlternative: LOCAL_ALTERNATIVE },
      args.target ? String(args.target) : undefined,
    )
    const { data } = await client.getSiteIndexingDiagnostics({
      params: { siteId: site.siteId },
      query: {
        ...(sampleIssues && sampleIssues.length > 0 ? { sampleIssues } : {}),
        ...(sampleLimit !== undefined ? { sampleLimit } : {}),
      },
    })

    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    console.log(`${site.siteUrl}: ${data.summary.indexed.toLocaleString('en-US')} / ${data.summary.totalUrls.toLocaleString('en-US')} indexed (${data.summary.indexedPercent.toFixed(1)}%)`)
    if (data.issues.length === 0) {
      logger.info('No indexing issue groups recorded.')
      return
    }
    console.log()
    for (const line of renderTable(
      data.issues.map(issue => ({
        severity: issue.severity,
        type: issue.type,
        label: issue.label,
        count: issue.count,
      })),
      [
        { key: 'severity', label: 'Severity' },
        { key: 'type', label: 'Issue' },
        { key: 'label', label: 'Label' },
        { key: 'count', label: 'URLs', numeric: true },
      ],
      terminalOutputOptions(),
    )) {
      console.log(line)
    }
  },
})
