import type {
  FleetSummarySortDir,
  FleetSummarySortField,
  FleetSummaryV1Data,
  FleetSummaryV1Request,
  FleetSummaryV1Totals,
} from '@gscdump/contracts/v1'
import type { FleetSummarySiteOutcome } from '@gscdump/sdk/fleet-summary'
import { analyzeTrajectory } from '@gscdump/analysis'
import { FLEET_SUMMARY_SORT_FIELDS, fleetSummaryV1RequestSchema } from '@gscdump/contracts/v1'
import { createEngineQuerySource } from '@gscdump/engine/source'
import { buildFleetSummary, computeFleetDeltas } from '@gscdump/sdk/fleet-summary'
import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { defineCommand } from 'citty'
import { getLatestGscDate } from 'gscdump/dates'
import { between, date } from 'gscdump/query'
import { unwrapResult } from 'gscdump/result'
import { hostedCredential, parseAuthentication, resolveAuthentication } from '../auth-state'
import { fleetCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { resolveCliEnvironment } from '../environment'
import { hostedRequestContext } from '../hosted-context'
import { renderTable, textLines } from '../render/layout'
import { formatChange, formatMetric } from '../render/metrics'
import { terminalOutputOptions } from '../render/terminal'
import { commandLineError } from '../stop'
import { readSiteMap, siteUrlForId } from '../store-sites'
import { applyOutputMode, OUTPUT_ARGS } from '../utils'
import { COMPARISON_FLAGS, parseWindowFlags, PERIOD_FLAGS, windowFlagErrorToException } from '../window'

const SORT_ALIASES: Readonly<Record<string, FleetSummarySortField>> = {
  'clicks': 'clicks',
  'clicks-delta': 'clicksDelta',
  'clicksDelta': 'clicksDelta',
  'clicks-delta-pct': 'clicksDeltaPct',
  'clicksDeltaPct': 'clicksDeltaPct',
  'impressions': 'impressions',
  'impressions-delta': 'impressionsDelta',
  'impressionsDelta': 'impressionsDelta',
  'impressions-delta-pct': 'impressionsDeltaPct',
  'impressionsDeltaPct': 'impressionsDeltaPct',
  'position-delta': 'positionDelta',
  'positionDelta': 'positionDelta',
}

export function parseFleetSort(raw: string | undefined): FleetSummarySortField {
  if (!raw)
    return 'clicks'
  const mapped = SORT_ALIASES[raw]
  if (!mapped)
    throw commandLineError(`Unknown --sort "${raw}". Valid: ${FLEET_SUMMARY_SORT_FIELDS.join(', ')}.`)
  return mapped
}

export function parseFleetSiteIds(raw: string | undefined): string[] | undefined {
  if (!raw)
    return undefined
  const values = [...new Set(raw.split(',').map(v => v.trim()).filter(Boolean))]
  return values.length > 0 ? values : undefined
}

export function buildHostedFleetRequest(args: Record<string, unknown>): FleetSummaryV1Request {
  const periodRaw = args.period ? String(args.period) : undefined
  const period = periodRaw
    ? periodRaw.replace(/^(\d+d)$/, 'last-$1')
    : (args.start || args.end ? 'custom' : 'last-28d')
  const sortBy = parseFleetSort(args.sort ? String(args.sort) : undefined)
  const sortDir: FleetSummarySortDir = args.asc ? 'asc' : 'desc'
  const siteIds = parseFleetSiteIds(args.sites ? String(args.sites) : undefined)
  const includeIndexing = Boolean(args.indexing)
  const includeTrajectory = Boolean(args.trajectory)

  return fleetSummaryV1RequestSchema.parse({
    period,
    comparison: args.vs ? String(args.vs) : 'prev-period',
    ...(args.start ? { startDate: String(args.start) } : {}),
    ...(args.end ? { endDate: String(args.end) } : {}),
    ...(args['search-type'] ? { searchType: String(args['search-type']) } : {}),
    ...(siteIds ? { siteIds } : {}),
    ...(includeIndexing || includeTrajectory ? { include: { indexing: includeIndexing, trajectory: includeTrajectory } } : {}),
    sortBy,
    sortDir,
  })
}

function aggregateDailyRows(rows: readonly Record<string, unknown>[]): FleetSummaryV1Totals {
  let clicks = 0
  let impressions = 0
  let weightedPos = 0
  let posImpressions = 0
  for (const row of rows) {
    const c = Number(row.clicks ?? 0)
    const imp = Number(row.impressions ?? 0)
    const pos = Number(row.position)
    if (Number.isFinite(c))
      clicks += c
    if (Number.isFinite(imp))
      impressions += imp
    if (Number.isFinite(pos) && Number.isFinite(imp) && imp > 0) {
      weightedPos += pos * imp
      posImpressions += imp
    }
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: posImpressions > 0 ? weightedPos / posImpressions : null,
  }
}

function inclusiveDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1)
}

async function runHostedFleet(args: Record<string, unknown>): Promise<FleetSummaryV1Data & { source: 'hosted', requestId: string }> {
  const environment = resolveCliEnvironment().values
  const authentication = args['api-key']
    ? parseAuthentication({ _tag: 'Hosted', apiKey: args['api-key'], apiRoot: String(args['api-root'] || environment.GSCDUMP_API_ROOT || 'https://gscdump.com/api') })
    : await resolveAuthentication()
  if (authentication._tag !== 'Hosted')
    throw new Error('Hosted mode required.')
  const client = createGscdumpV1Client({
    apiRoot: authentication.apiRoot,
    credential: hostedCredential(authentication),
    requestContext: hostedRequestContext(environment),
  })
  const body = buildHostedFleetRequest(args)
  const response = await client.queryFleetSummary({ body })
  return {
    ...response.data,
    source: 'hosted',
    requestId: response.meta.requestId,
  }
}

async function runLocalFleet(args: Record<string, unknown>): Promise<FleetSummaryV1Data & { source: 'local' }> {
  const ctx = await createCommandContext({ needsStore: true })
  const store = ctx.store!
  const sortBy = parseFleetSort(args.sort ? String(args.sort) : undefined)
  const sortDir: FleetSummarySortDir = args.asc ? 'asc' : 'desc'
  const searchType = (args['search-type'] ? String(args['search-type']) : 'web') as FleetSummaryV1Data['searchType']
  const filterSites = parseFleetSiteIds(args.sites ? String(args.sites) : undefined)
  const includeTrajectory = Boolean(args.trajectory)

  const [allEntries, watermarks, siteMap] = await Promise.all([
    store.engine.listAll({ userId: store.userId }),
    store.engine.getWatermarks({ userId: store.userId }),
    readSiteMap(store.dataDir, store.userId),
  ])

  const siteIds = [...new Set(allEntries
    .filter(e => e.retiredAt === undefined && e.siteId !== undefined)
    .map(e => e.siteId!))]
    .filter(id => !filterSites || filterSites.includes(id) || filterSites.includes(siteUrlForId(siteMap, id)))
    .sort()

  const latestSynced = watermarks
    .map(w => w.newestDateSynced)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1)
  const anchor = latestSynced ?? getLatestGscDate()
  const resolved = unwrapResult(parseWindowFlags({
    period: args.period ? String(args.period) : undefined,
    vs: args.vs ? String(args.vs) : undefined,
    start: args.start ? String(args.start) : undefined,
    end: args.end ? String(args.end) : undefined,
  }, { preset: 'last-28d', comparison: 'prev-period' }, anchor), windowFlagErrorToException)

  const window: FleetSummaryV1Data['window'] = {
    startDate: resolved.start,
    endDate: resolved.end,
    days: inclusiveDays(resolved.start, resolved.end),
    ...(resolved.comparison ? { comparison: { startDate: resolved.comparison.start, endDate: resolved.comparison.end } } : {}),
  }

  const outcomes: FleetSummarySiteOutcome[] = []
  for (const siteId of siteIds) {
    const siteUrl = siteUrlForId(siteMap, siteId)
    const siteWatermarks = watermarks.filter(w => w.siteId === siteId && (w.searchType ?? 'web') === searchType)
    const oldestDateSynced = siteWatermarks.map(w => w.oldestDateSynced).filter(Boolean).sort()[0] ?? null
    const newestDateSynced = siteWatermarks.map(w => w.newestDateSynced).filter(Boolean).sort().at(-1) ?? null

    if (!newestDateSynced) {
      outcomes.push({
        _tag: 'NotSynced',
        siteId,
        siteUrl,
        gscProperty: siteUrl,
        partner: null,
        syncStatus: 'unsynced',
        oldestDateSynced,
        newestDateSynced,
        reason: 'No synced analytics partitions found in local Store.',
      })
      continue
    }

    const source = createEngineQuerySource({ engine: store.engine, ctx: { userId: store.userId, siteId } })
    const syncedTables = new Set(siteWatermarks.map(w => w.table))
    // Prefer exact site-level tables (`dates`, then `countries`, then `pages`)
    // so local Stores synced without a dedicated `dates` table still aggregate accurately.
    const queryDims: Array<'date' | 'country' | 'page'> = syncedTables.has('dates')
      ? ['date']
      : syncedTables.has('countries')
        ? ['date', 'country']
        : syncedTables.has('pages')
          ? ['date', 'page']
          : ['date']

    const collapseByDate = (rows: readonly Record<string, unknown>[]): Record<string, unknown>[] => {
      if (queryDims.length === 1)
        return [...rows]
      const byDate = new Map<string, { clicks: number, impressions: number, weightedPos: number, posImpressions: number }>()
      for (const row of rows) {
        const d = String(row.date ?? '')
        if (!d)
          continue
        const c = Number(row.clicks ?? 0)
        const imp = Number(row.impressions ?? 0)
        const pos = Number(row.position)
        const acc = byDate.get(d) ?? { clicks: 0, impressions: 0, weightedPos: 0, posImpressions: 0 }
        if (Number.isFinite(c))
          acc.clicks += c
        if (Number.isFinite(imp))
          acc.impressions += imp
        if (Number.isFinite(pos) && Number.isFinite(imp) && imp > 0) {
          acc.weightedPos += pos * imp
          acc.posImpressions += imp
        }
        byDate.set(d, acc)
      }
      return [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, acc]) => ({
          date: d,
          clicks: acc.clicks,
          impressions: acc.impressions,
          ctr: acc.impressions > 0 ? acc.clicks / acc.impressions : 0,
          position: acc.posImpressions > 0 ? acc.weightedPos / acc.posImpressions : null,
        }))
    }

    try {
      const currentRows = collapseByDate(await source.queryRows({
        dimensions: queryDims,
        filter: between(date, window.startDate, window.endDate),
        searchType,
        orderBy: { column: 'date', dir: 'asc' },
      }))
      if (currentRows.length === 0) {
        outcomes.push({
          _tag: 'Empty',
          siteId,
          siteUrl,
          gscProperty: siteUrl,
          partner: null,
          syncStatus: 'idle',
          oldestDateSynced,
          newestDateSynced,
          reason: 'No traffic rows recorded in requested window.',
        })
        continue
      }
      const totals = aggregateDailyRows(currentRows)
      const previousRows = window.comparison
        ? collapseByDate(await source.queryRows({
            dimensions: queryDims,
            filter: between(date, window.comparison.startDate, window.comparison.endDate),
            searchType,
            orderBy: { column: 'date', dir: 'asc' },
          }))
        : []
      const previousTotals = window.comparison ? aggregateDailyRows(previousRows) : undefined
      const deltas = previousTotals ? computeFleetDeltas(totals, previousTotals) : undefined
      const complete = Boolean(
        oldestDateSynced && oldestDateSynced <= window.startDate
        && newestDateSynced && newestDateSynced >= window.endDate,
      )
      const trajectory = includeTrajectory
        ? (() => {
            const t = analyzeTrajectory({
              days: currentRows.map(r => ({
                date: String(r.date ?? ''),
                clicks: Number(r.clicks ?? 0),
                impressions: Number(r.impressions ?? 0),
              })),
              knownThrough: newestDateSynced < window.endDate ? newestDateSynced : window.endDate,
            })
            return {
              peakWeekClicks: t.peak?.clicks ?? null,
              latestWeekClicks: t.latest?.clicks ?? null,
              latestToPeakRatio: t.latestToPeakRatio,
              classification: t.classification._tag,
            }
          })()
        : undefined

      outcomes.push({
        _tag: 'Ok',
        siteId,
        siteUrl,
        gscProperty: siteUrl,
        partner: null,
        syncStatus: 'idle',
        oldestDateSynced,
        newestDateSynced,
        coverage: {
          startDate: oldestDateSynced,
          endDate: newestDateSynced,
          complete,
        },
        totals,
        ...(previousTotals ? { previousTotals, deltas } : {}),
        ...(trajectory ? { trajectory } : {}),
      })
    }
    catch (error) {
      outcomes.push({
        _tag: 'Unavailable',
        siteId,
        siteUrl,
        gscProperty: siteUrl,
        partner: null,
        syncStatus: 'error',
        oldestDateSynced,
        newestDateSynced,
        reason: error instanceof Error ? error.message : String(error),
        retryable: true,
      })
    }
  }

  return {
    ...buildFleetSummary({
      window,
      searchType,
      sortBy,
      sortDir,
      sites: outcomes,
    }),
    source: 'local',
  }
}

export function renderFleetSummary(summary: FleetSummaryV1Data): string {
  const options = terminalOutputOptions()
  const header = `Fleet / ${summary.window.startDate} to ${summary.window.endDate}${summary.window.comparison ? ` vs ${summary.window.comparison.startDate} to ${summary.window.comparison.endDate}` : ''}`
  const rows = summary.sites.map((site) => {
    if (site._tag !== 'Ok') {
      return {
        site: site.siteUrl,
        clicks: 'n/a',
        delta: site._tag,
        impressions: 'n/a',
        ctr: 'n/a',
        position: 'n/a',
        status: site.reason,
      }
    }
    const change = site.previousTotals
      ? formatChange('clicks', site.totals.clicks, site.previousTotals.clicks)
      : { text: 'n/a', direction: 'neutral' as const }
    return {
      site: site.siteUrl,
      clicks: formatMetric('clicks', site.totals.clicks),
      delta: change.text,
      impressions: formatMetric('impressions', site.totals.impressions),
      ctr: formatMetric('ctr', site.totals.ctr),
      position: site.totals.position == null ? 'n/a' : formatMetric('position', site.totals.position),
      status: site.coverage.complete ? 'ok' : 'partial',
    }
  })

  const lines = [
    ...textLines(header, options, 'accent'),
    '',
    ...renderTable(rows, [
      { key: 'site', label: 'Site' },
      { key: 'clicks', label: 'Clicks', numeric: true },
      { key: 'delta', label: 'Delta', numeric: true },
      { key: 'impressions', label: 'Impr.', numeric: true },
      { key: 'ctr', label: 'CTR', numeric: true },
      { key: 'position', label: 'Pos', numeric: true },
      { key: 'status', label: 'Status' },
    ], options),
  ]

  const dt = summary.deduplicatedTotals
  const totalDelta = dt.previousTotals
    ? ` (${formatChange('clicks', dt.totals.clicks, dt.previousTotals.clicks).text})`
    : ''
  lines.push(
    '',
    ...textLines(
      `Fleet total (${dt._tag}, ${dt.uniqueSiteUrls} unique Sites): ${formatMetric('clicks', dt.totals.clicks)} clicks${totalDelta}, ${formatMetric('impressions', dt.totals.impressions)} impressions`,
      options,
      dt._tag === 'Complete' ? 'muted' : 'warning',
    ),
  )
  return lines.join('\n')
}

export const fleetCommand = defineCommand({
  meta: fleetCommandMeta,
  args: {
    'period': { type: 'string', description: `Window: ${PERIOD_FLAGS.join('|')} (default: 28d)` },
    'vs': { type: 'string', description: `Comparison: ${COMPARISON_FLAGS.join('|')} (default: prev-period)` },
    'start': { type: 'string', description: 'Custom start date (YYYY-MM-DD)' },
    'end': { type: 'string', description: 'Custom end date (YYYY-MM-DD)' },
    'search-type': { type: 'string', description: 'Search type (default: web)' },
    'sites': { type: 'string', description: 'Comma-separated Site IDs or Site URLs to include' },
    'sort': { type: 'string', description: `Sort field: ${FLEET_SUMMARY_SORT_FIELDS.join('|')} (default: clicks)` },
    'asc': { type: 'boolean', default: false, description: 'Sort ascending (useful with --sort clicks-delta to show biggest drops first)' },
    'indexing': { type: 'boolean', default: false, description: 'Include per-Site indexing counts (Hosted mode)' },
    'trajectory': { type: 'boolean', default: false, description: 'Include per-Site trajectory summary' },
    'api-root': { type: 'string', description: 'Hosted API root override' },
    'api-key': { type: 'string', description: 'Hosted API key override' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const auth = args['api-key'] ? { _tag: 'Hosted' as const } : await resolveAuthentication()
    const summary = auth._tag === 'Hosted'
      ? await runHostedFleet(args)
      : await runLocalFleet(args)

    if (json) {
      console.log(JSON.stringify(summary, null, 2))
      return
    }
    console.log(renderFleetSummary(summary))
  },
})
