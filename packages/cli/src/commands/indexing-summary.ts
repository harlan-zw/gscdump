import type { GscdumpV1OperationResponse } from '@gscdump/sdk/v1'
import { COVERAGE_LADDER } from '@gscdump/contracts'
import { defineCommand } from 'citty'
import { HOSTED_ARGS, resolveHostedSite } from '../hosted-site'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { applyOutputMode, logger, parseIntegerOption } from '../utils'

type IndexingSummary = GscdumpV1OperationResponse<'partner.sites.indexing.get'>['data']
type TrendPoint = IndexingSummary['trend'][number]
type Capture = NonNullable<IndexingSummary['capture']>

const MAX_DAYS = 90

function ladderRow(point: TrendPoint): Record<string, unknown> {
  const states = point.coverageStates
  if (!states || states._tag === 'not_counted')
    return { date: point.date, unknown_to_google: 'not counted', discovered_not_indexed: '', crawled_not_indexed: '', indexed: '', capturedAt: '' }
  return {
    date: point.date,
    ...Object.fromEntries(COVERAGE_LADDER.map(tag => [tag, states.counts[tag]])),
    capturedAt: states.capturedAt.slice(0, 16).replace('T', ' '),
  }
}

function captureLines(capture: Capture | undefined): string[] {
  if (!capture)
    return ['This host does not report when it counted the verdicts.']
  if (capture._tag === 'empty')
    return ['No URL Inspection verdicts are stored for this Site.']
  const lines = [
    `Counted ${capture.capturedAt} from stored URL Inspection verdicts (${capture.source}).`,
    `Verdicts inspected between ${capture.oldestVerdictAt ?? 'unknown'} and ${capture.newestVerdictAt ?? 'unknown'}.`,
  ]
  if (capture.freshness._tag === 'measured') {
    const { verdicts, olderThan7dPercent, olderThan30dPercent } = capture.freshness
    lines.push(`Of ${verdicts} verdicts, ${olderThan7dPercent}% are older than 7 days and ${olderThan30dPercent}% are older than 30 days.`)
  }
  return lines
}

export const indexingSummaryCommand = defineCommand({
  meta: {
    name: 'summary',
    description: 'Show the coverage ladder per day from stored URL Inspection verdicts, with capture time (hosted)',
  },
  args: {
    ...HOSTED_ARGS,
    days: { type: 'string', default: '28', description: `Trend days, 1 to ${MAX_DAYS}` },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info output' },
  },
  async run({ args }) {
    const days = parseIntegerOption(args.days, '--days') ?? 28
    if (days < 1 || days > MAX_DAYS)
      throw new Error(`--days must be between 1 and ${MAX_DAYS}.`)
    const { json } = applyOutputMode(args)

    const { client, site } = await resolveHostedSite(args, {
      name: 'indexing summary',
      localAlternative: 'run `gscdump inspect --site <site>` and read the saved results with `gscdump entities`',
    })
    const { data } = await client.getSiteIndexing({ params: { siteId: site.siteId }, query: { days } })

    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    const options = terminalOutputOptions()
    if (data.trend.length === 0) {
      logger.info(`No daily coverage counts are stored for ${site.siteUrl}.`)
    }
    else {
      for (const line of renderTable(data.trend.map(ladderRow), [
        { key: 'date', label: 'Date', numeric: true },
        { key: 'unknown_to_google', label: 'Unknown', numeric: true },
        { key: 'discovered_not_indexed', label: 'Discovered', numeric: true },
        { key: 'crawled_not_indexed', label: 'Crawled', numeric: true },
        { key: 'indexed', label: 'Indexed', numeric: true },
        { key: 'capturedAt', label: 'Counted (UTC)' },
      ], options)) {
        console.log(line)
      }
    }
    for (const line of captureLines(data.capture))
      console.log(line)
    logger.info('These counts are stored URL Inspection verdicts. They are not Google\'s live index or the Search Console Page indexing report.')
  },
})
