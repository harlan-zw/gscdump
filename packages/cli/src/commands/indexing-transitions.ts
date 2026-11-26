import { GSCDUMP_INDEXING_TRANSITION_FIELDS } from '@gscdump/contracts'
import { defineCommand } from 'citty'
import { HOSTED_ARGS, resolveHostedSiteWithTarget } from '../hosted-site'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { commandLineError } from '../stop'
import { applyOutputMode, logger, OUTPUT_ARGS, parseIntegerOption } from '../utils'

type TransitionField = (typeof GSCDUMP_INDEXING_TRANSITION_FIELDS)[number]

const LOCAL_ALTERNATIVE = 'run `gscdump inspect --site <site>` over time and compare saved results with `gscdump entities`'

export const indexingTransitionsCommand = defineCommand({
  meta: {
    name: 'transitions',
    description: 'List observed URL Inspection state transitions as bounded observation windows (hosted)',
  },
  args: {
    target: { type: 'positional', required: false, description: 'Site URL or Site ID (or pass --site)' },
    ...HOSTED_ARGS,
    start: { type: 'string', description: 'Window start date (YYYY-MM-DD; pass with --end)' },
    end: { type: 'string', description: 'Window end date (YYYY-MM-DD; pass with --start)' },
    field: { type: 'string', description: `Filter by field: ${GSCDUMP_INDEXING_TRANSITION_FIELDS.join(', ')}` },
    from: { type: 'string', description: 'Filter by previous field value' },
    to: { type: 'string', description: 'Filter by new field value' },
    limit: { type: 'string', alias: 'l', description: 'Max rows (1 to 500)' },
    offset: { type: 'string', description: 'Pagination offset' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const startDate = args.start ? String(args.start) : undefined
    const endDate = args.end ? String(args.end) : undefined
    if ((startDate === undefined) !== (endDate === undefined))
      throw commandLineError('Pass --start and --end together.')
    const fieldRaw = args.field ? String(args.field) : undefined
    if (fieldRaw && !(GSCDUMP_INDEXING_TRANSITION_FIELDS as readonly string[]).includes(fieldRaw))
      throw commandLineError(`Invalid --field "${fieldRaw}". Allowed: ${GSCDUMP_INDEXING_TRANSITION_FIELDS.join(', ')}.`)
    const limit = parseIntegerOption(args.limit, '--limit')
    if (limit !== undefined && (limit < 1 || limit > 500))
      throw commandLineError('--limit must be between 1 and 500.')
    const offset = parseIntegerOption(args.offset, '--offset', 0)

    const { client, site } = await resolveHostedSiteWithTarget(
      args as Record<string, unknown>,
      { name: 'indexing transitions', localAlternative: LOCAL_ALTERNATIVE },
      args.target ? String(args.target) : undefined,
    )
    const { data } = await client.listSiteIndexingTransitions({
      params: { siteId: site.siteId },
      query: {
        ...(startDate && endDate ? { startDate, endDate } : {}),
        ...(fieldRaw ? { field: fieldRaw as TransitionField } : {}),
        ...(args.from ? { fromValue: String(args.from) } : {}),
        ...(args.to ? { toValue: String(args.to) } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      },
    })

    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    if (data.transitions.length === 0) {
      logger.info(`No indexing transitions observed for ${site.siteUrl} (${data.meta.startDate} to ${data.meta.endDate}).`)
      return
    }
    for (const line of renderTable(
      data.transitions.map(row => ({
        url: row.url,
        field: row.field,
        fromValue: row.fromValue ?? '(none)',
        toValue: row.toValue ?? '(none)',
        window: `${row.changedAfter.slice(0, 10)} to ${row.changedBefore.slice(0, 10)}`,
        gapDays: row.observationGapDays,
      })),
      [
        { key: 'url', label: 'URL' },
        { key: 'field', label: 'Field' },
        { key: 'fromValue', label: 'From' },
        { key: 'toValue', label: 'To' },
        { key: 'window', label: 'Observed window' },
        { key: 'gapDays', label: 'Gap (d)', numeric: true },
      ],
      terminalOutputOptions(),
    )) {
      console.log(line)
    }
    if (data.observationWindow._tag === 'sampled')
      logger.info(`${data.pagination.total} transition${data.pagination.total === 1 ? '' : 's'} (median gap ${data.observationWindow.gapDaysMedian}d, p90 ${data.observationWindow.gapDaysP90}d). Windows bound when inspections observed the change.`)
  },
})
