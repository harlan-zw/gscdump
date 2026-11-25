import type { TableName } from '@gscdump/contracts'
import type {
  FleetSummarySortDir,
  FleetSummarySortField,
  FleetSummaryV1Data,
  FleetSummaryV1Request,
  FleetSummaryV1Totals,
} from '@gscdump/contracts/v1'
import type { FleetSummarySiteOutcome } from '@gscdump/sdk/fleet-summary'
import type { SiteManager } from '../auth-state'
import type { HostedSite } from '../hosted-site'
import type { LocalStore } from '../local-store'
import { analyzeTrajectory } from '@gscdump/analysis'
import { FLEET_SUMMARY_SORT_FIELDS, fleetSummaryV1RequestSchema } from '@gscdump/contracts/v1'
import { buildFleetSummary, computeFleetDeltas } from '@gscdump/sdk/fleet-summary'
import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { defineCommand } from 'citty'
import { getLatestGscDate } from 'gscdump/dates'
import { between, date } from 'gscdump/query'
import { unwrapResult } from 'gscdump/result'
import { getHostedAccount, hostedCredential, parseAuthentication, resolveAuthentication, siteManagerOf } from '../auth-state'
import { fleetCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { resolveCliEnvironment } from '../environment'
import { hostedRequestContext } from '../hosted-context'
import { matchHostedSite, siteMatchStop } from '../hosted-site'
import { renderTable, textLines } from '../render/layout'
import { formatChange, formatMetric } from '../render/metrics'
import { terminalOutputOptions } from '../render/terminal'
import { commandLineError, stopError } from '../stop'
import { readSiteMap, siteUrlForId } from '../store-sites'
import { applyOutputMode, OUTPUT_ARGS, parseSearchType } from '../utils'
import {
  checkWindowFlags,
  COMPARISON_ALIASES,
  COMPARISON_FLAGS,
  parseWindowFlags,
  PERIOD_ALIASES,
  PERIOD_FLAGS,
  windowFlagErrorToException,
} from '../window'

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

const LOCAL_AGGREGATE_TABLES: readonly TableName[] = ['dates', 'countries', 'pages']

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

export function resolveHostedSiteTokens(
  sites: readonly HostedSite[],
  tokens: readonly string[],
  manager: SiteManager,
): string[] {
  const resolved = new Set<string>()
  for (const token of tokens) {
    const match = matchHostedSite(sites, token)
    if (match.kind !== 'found')
      throw stopError(siteMatchStop(match, manager))
    resolved.add(match.site.siteId)
  }
  return [...resolved]
}

export function buildHostedFleetRequest(
  args: Record<string, unknown>,
  resolvedSiteIds?: readonly string[],
): FleetSummaryV1Request {
  const periodRaw = args.period ? String(args.period) : undefined
  const vsRaw = args.vs ? String(args.vs) : undefined
  const startRaw = args.start ? String(args.start) : undefined
  const endRaw = args.end ? String(args.end) : undefined

  const flagError = checkWindowFlags({ period: periodRaw, vs: vsRaw, start: startRaw, end: endRaw })
  if (flagError)
    throw windowFlagErrorToException(flagError)

  const period = periodRaw
    ? PERIOD_ALIASES[periodRaw.toLowerCase()]!
    : (startRaw || endRaw ? 'custom' : 'last-28d')
  const comparison = vsRaw ? COMPARISON_ALIASES[vsRaw.toLowerCase()]! : 'prev-period'
  const searchType = parseSearchType(args['search-type']) ?? 'web'
  const sortBy = parseFleetSort(args.sort ? String(args.sort) : undefined)
  const sortDir: FleetSummarySortDir = args.asc ? 'asc' : 'desc'
  const siteIds = resolvedSiteIds ? [...resolvedSiteIds] : parseFleetSiteIds(args.sites ? String(args.sites) : undefined)
  const includeIndexing = Boolean(args.indexing)
  const includeTrajectory = Boolean(args.trajectory)

  const parsed = fleetSummaryV1RequestSchema.safeParse({
    period,
    comparison,
    ...(startRaw ? { startDate: startRaw } : {}),
    ...(endRaw ? { endDate: endRaw } : {}),
    searchType,
    ...(siteIds ? { siteIds } : {}),
    ...(includeIndexing || includeTrajectory ? { include: { indexing: includeIndexing, trajectory: includeTrajectory } } : {}),
    sortBy,
    sortDir,
  })
  if (!parsed.success)
    throw commandLineError(parsed.error.issues[0]?.message ?? 'Invalid fleet options.')
  return parsed.data
}

function formatRowDate(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && Number.isFinite(value))
    return new Date(value > 1e10 ? value : value * 86_400_000).toISOString().slice(0, 10)
  if (typeof value === 'bigint') {
    const n = Number(value)
    return new Date(n > 1e10 ? n : n * 86_400_000).toISOString().slice(0, 10)
  }
  return String(value ?? '').slice(0, 10)
}

function aggregateDailyRows(rows: readonly Record<string, unknown>[]): FleetSummaryV1Totals {
  let clicks = 0
  let impressions = 0
  let weightedPos = 0
  let posImpressions = 0
  for (const row of rows) {
    const c = Number(row.clicks ?? 0)
    const imp = Number(row.impressions ?? 0)
    const pos = row.position != null && row.position !== '' ? Number(row.position) : Number.NaN
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

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && aEnd >= bStart
}

function clampDate(value: string, min: string, max: string): string {
  if (value < min)
    return min
  if (value > max)
    return max
  return value
}

async function runHostedFleet(args: Record<string, unknown>): Promise<FleetSummaryV1Data & { source: 'hosted', requestId: string }> {
  const environment = resolveCliEnvironment().values
  const authentication = args['api-key']
    ? parseAuthentication({ _tag: 'Hosted', apiKey: args['api-key'], apiRoot: String(args['api-root'] || environment.GSCDUMP_API_ROOT || 'https://gscdump.com/api') })
    : await resolveAuthentication()
  if (authentication._tag !== 'Hosted')
    throw new Error('Hosted mode required.')
  if (args['api-root'] && String(args['api-root']).replace(/\/+$/, '') !== authentication.apiRoot)
    throw new Error('The API root changed. Pass --api-key for the new API root.')

  const rawSites = parseFleetSiteIds(args.sites ? String(args.sites) : undefined)
  const resolvedSiteIds = rawSites
    ? await (async () => {
        const account = await getHostedAccount(authentication)
        return resolveHostedSiteTokens(account.sites, rawSites, siteManagerOf(authentication, account.issuer))
      })()
    : undefined

  const client = createGscdumpV1Client({
    apiRoot: authentication.apiRoot,
    credential: hostedCredential(authentication),
    requestContext: hostedRequestContext(environment),
  })
  const body = buildHostedFleetRequest(args, resolvedSiteIds)
  const response = await client.queryFleetSummary({ body })
  return {
    ...response.data,
    source: 'hosted',
    requestId: response.meta.requestId,
  }
}

export async function runLocalFleetWithStore(
  store: LocalStore,
  args: Record<string, unknown>,
): Promise<FleetSummaryV1Data & { source: 'local' }> {
  const sortBy = parseFleetSort(args.sort ? String(args.sort) : undefined)
  const sortDir: FleetSummarySortDir = args.asc ? 'asc' : 'desc'
  const searchType = parseSearchType(args['search-type']) ?? 'web'
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
  const siteIdSet = new Set(siteIds)

  const latestSynced = watermarks
    .filter(w =>
      w.siteId !== undefined
      && siteIdSet.has(w.siteId)
      && (w.searchType ?? 'web') === searchType
      && LOCAL_AGGREGATE_TABLES.includes(w.table as TableName),
    )
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

  const queryDailyRange = async (siteId: string, table: TableName, startDate: string, endDate: string): Promise<Record<string, unknown>[]> => {
    const result = await store.engine.query(
      { userId: store.userId, siteId, table, searchType },
      {
        dimensions: ['date'],
        filter: between(date, startDate, endDate),
        orderBy: { column: 'date', dir: 'asc' },
        rowLimit: inclusiveDays(startDate, endDate) + 8,
      },
    )
    return result.rows as Record<string, unknown>[]
  }

  const outcomes: FleetSummarySiteOutcome[] = []
  for (const siteId of siteIds) {
    const siteUrl = siteUrlForId(siteMap, siteId)
    const siteWatermarks = watermarks.filter(w => w.siteId === siteId && (w.searchType ?? 'web') === searchType)
    const tableWatermark = LOCAL_AGGREGATE_TABLES
      .map(table => siteWatermarks.find(w => w.table === table && w.newestDateSynced))
      .find((w): w is NonNullable<typeof w> => Boolean(w))

    if (!tableWatermark || !tableWatermark.oldestDateSynced || !tableWatermark.newestDateSynced) {
      outcomes.push({
        _tag: 'NotSynced',
        siteId,
        siteUrl,
        gscProperty: siteUrl,
        partner: null,
        syncStatus: 'unsynced',
        oldestDateSynced: null,
        newestDateSynced: null,
        reason: `No synced dates, countries, or pages partitions for ${searchType} in local Store.`,
      })
      continue
    }

    const selectedTable = tableWatermark.table as TableName
    const oldestDateSynced = tableWatermark.oldestDateSynced
    const newestDateSynced = tableWatermark.newestDateSynced

    if (!rangesOverlap(oldestDateSynced, newestDateSynced, window.startDate, window.endDate)) {
      outcomes.push({
        _tag: 'NotSynced',
        siteId,
        siteUrl,
        gscProperty: siteUrl,
        partner: null,
        syncStatus: 'idle',
        oldestDateSynced,
        newestDateSynced,
        reason: `Synced ${searchType} range (${oldestDateSynced} to ${newestDateSynced}) does not cover ${window.startDate} to ${window.endDate}.`,
      })
      continue
    }

    try {
      const currentRows = await queryDailyRange(siteId, selectedTable, window.startDate, window.endDate)
      const comparisonCovered = Boolean(
        window.comparison
        && oldestDateSynced <= window.comparison.startDate
        && newestDateSynced >= window.comparison.endDate,
      )
      const previousRows = comparisonCovered && window.comparison
        ? await queryDailyRange(siteId, selectedTable, window.comparison.startDate, window.comparison.endDate)
        : []

      if (currentRows.length === 0 && previousRows.length === 0) {
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
      const previousTotals = comparisonCovered ? aggregateDailyRows(previousRows) : undefined
      const deltas = previousTotals ? computeFleetDeltas(totals, previousTotals) : undefined

      const primaryComplete = oldestDateSynced <= window.startDate && newestDateSynced >= window.endDate
      const complete = primaryComplete && (!window.comparison || comparisonCovered)

      const trajectory = includeTrajectory
        ? await (async () => {
            const historyRows = await queryDailyRange(siteId, selectedTable, oldestDateSynced, newestDateSynced)
            const t = analyzeTrajectory({
              days: historyRows.map(r => ({
                date: formatRowDate(r.date),
                clicks: Number(r.clicks ?? 0),
                impressions: Number(r.impressions ?? 0),
              })),
              knownThrough: newestDateSynced,
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
          startDate: clampDate(oldestDateSynced, window.startDate, window.endDate),
          endDate: clampDate(newestDateSynced, window.startDate, window.endDate),
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

async function runLocalFleet(args: Record<string, unknown>): Promise<FleetSummaryV1Data & { source: 'local' }> {
  const ctx = await createCommandContext({ needsStore: true })
  return runLocalFleetWithStore(ctx.store!, args)
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
