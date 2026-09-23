import type { QuerySpan } from '@gscdump/engine/profile'
import type { googleSearchConsole } from 'gscdump/client'
import type { BuilderState, Column, Dimension, Filter, SearchType } from 'gscdump/query'
import type { TableName } from '../local-store'
import type { RouteNeed, RouteRequest } from '../route'
import type { SqlResult, SqlViews } from '../sql-views'
import type { WindowFlags } from '../window'
import fs from 'node:fs/promises'
import process from 'node:process'
import { cancel, isCancel, multiselect, text } from '@clack/prompts'
import { collectSpans } from '@gscdump/engine/profile'
import { defineCommand } from 'citty'
import { getLatestGscDate } from 'gscdump/dates'
import { and, between, country, date as dateCol, device, gsc, hour, page, query as queryCol, searchAppearance } from 'gscdump/query'
import { inferDataset, isDatasetResolvable } from 'gscdump/query/plan'
import { queryCommandMeta } from '../command-meta'
import { loadConfig } from '../config'
import { createCommandContext, formatSiteResolution } from '../context'
import { FILTER_DIMS, filterDimensions, parseFilterArgs, toLiveFilter, toLocalFilter } from '../filters'
import { allTables } from '../local-store'
import { asRecord, columnsFor } from '../render/analysis'
import { renderTable } from '../render/layout'
import { renderQuery } from '../render/query'
import { terminalOutputOptions } from '../render/terminal'
import { decideRoute, describeStop, liveNote, readRouteState, readSiteStates, resolveReadSite, stopAtRoute } from '../route'
import { useCliRuntime } from '../runtime'
import { openSqlViews, referencedTables } from '../sql-views'
import { ALL_SEARCH_TYPES, logger, parseSearchType, toCSV } from '../utils'
import { checkWindowFlags, DEFAULT_WINDOW, newestDoneDate, parseWindowFlags } from '../window'

const DIMENSIONS = ['page', 'query', 'date', 'hour', 'country', 'device', 'searchAppearance'] as const
type DimensionName = typeof DIMENSIONS[number]

const DIM_COLUMNS: Record<DimensionName, Column<Dimension>> = {
  page,
  query: queryCol,
  date: dateCol,
  hour,
  country,
  device,
  searchAppearance,
}

const DATA_STATES = ['all', 'final', 'hourly_all'] as const
const AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty'] as const
const POSITIVE_INTEGER_RE = /^\d+$/

async function runLiveQuery(
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  opts: {
    startDate: string
    endDate: string
    dimensions: string[]
    rowLimit: number
    searchType?: SearchType
    dataState?: string
    aggregationType?: string
    dimensionFilter?: Filter<any>
  },
): Promise<{ rows: Record<string, unknown>[] }> {
  const allRows: Record<string, unknown>[] = []
  const totalLimit = Math.max(0, opts.rowLimit)
  const pageSize = Math.min(totalLimit, 25000)
  let startRow = 0
  // Use the builder to derive a body so we get filterGroups for free.
  const baseBody: Record<string, unknown> = {
    startDate: opts.startDate,
    endDate: opts.endDate,
    dimensions: opts.dimensions,
  }
  if (opts.searchType)
    baseBody.type = opts.searchType
  if (opts.dataState)
    baseBody.dataState = opts.dataState
  if (opts.aggregationType)
    baseBody.aggregationType = opts.aggregationType
  if (opts.dimensionFilter) {
    const groups = filterToGroups(opts.dimensionFilter)
    if (groups.length > 0)
      baseBody.dimensionFilterGroups = groups
  }

  while (allRows.length < totalLimit) {
    const remaining = totalLimit - allRows.length
    const rowLimit = Math.min(pageSize, remaining)
    if (rowLimit <= 0)
      break
    const response = await client.searchAnalytics.query(siteUrl, { ...baseBody, rowLimit, startRow } as any)
    const rows = (response.rows || []).map((row) => {
      const result: Record<string, unknown> = {
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      }
      opts.dimensions.forEach((dim, i) => {
        result[dim] = row.keys?.[i]
      })
      return result
    })
    if (rows.length === 0)
      break
    allRows.push(...rows)
    startRow += rows.length
  }

  return { rows: allRows }
}

// Flatten a single AND filter (one or more leaf filters) into one
// dimensionFilterGroups entry. Mixed and/or aren't expressed via these CLI
// args, so we emit a single AND group.
function filterToGroups(f: Filter<any>): Array<{ groupType?: string, filters: Array<{ dimension: string, operator: string, expression: string }> }> {
  if (f._filters.length === 0)
    return []
  return [{
    filters: f._filters.map(leaf => ({
      dimension: leaf.dimension,
      operator: leaf.operator,
      expression: leaf.expression,
    })),
  }]
}

export const queryCommand = defineCommand({
  meta: queryCommandMeta,
  args: {
    'site': {
      type: 'string',
      alias: 's',
      description: 'Site, for example example.com',
    },
    'dimensions': {
      type: 'string',
      alias: 'd',
      description: `Dimensions: ${DIMENSIONS.join(',')}`,
    },
    'start': {
      type: 'string',
      description: 'Start date (YYYY-MM-DD)',
    },
    'end': {
      type: 'string',
      description: 'End date (YYYY-MM-DD)',
    },
    'limit': {
      type: 'string',
      alias: 'l',
      description: 'Max rows (default: saved defaultLimit or 1000)',
    },
    'output': {
      type: 'string',
      alias: 'o',
      description: 'Output file path (default: stdout)',
    },
    'format': {
      type: 'string',
      alias: 'f',
      description: 'Output format: table, json, or csv (default: saved defaultFormat or json)',
    },
    'sql': {
      type: 'string',
      description: 'DuckDB SQL over one view per Store table, with site and search_type columns. Example: SELECT search_type, SUM(clicks) AS clicks, gsc_position(sum_position, impressions) AS position FROM pages GROUP BY search_type. Run --schema to list views',
    },
    'schema': {
      type: 'boolean',
      default: false,
      description: 'List the --sql views, their columns, and the date range of each view, then exit',
    },
    'live': {
      type: 'boolean',
      default: false,
      description: 'Bypass local store; hit the GSC API directly',
    },
    'quiet': {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress progress output',
    },
    'interactive': {
      type: 'boolean',
      alias: 'i',
      default: false,
      description: 'Interactive mode',
    },
    'query': {
      type: 'string',
      description: 'Filter by query (prefix: ~contains, !exclude, re:regex, !re:not-regex)',
    },
    'page': {
      type: 'string',
      description: 'Filter by page (same prefix syntax as --query)',
    },
    'country': {
      type: 'string',
      description: 'Filter by country (ISO-3 lowercase, e.g. usa). Same prefix syntax as --query',
    },
    'device': {
      type: 'string',
      description: 'Filter by device (DESKTOP/MOBILE/TABLET). Same prefix syntax',
    },
    'search-appearance': {
      type: 'string',
      description: 'Filter by search appearance feature. Same prefix syntax',
    },
    'type': {
      type: 'string',
      description: `Search type. One of: ${ALL_SEARCH_TYPES.join(',')} (default: web; --sql and --schema default to every search type)`,
    },
    'data-state': {
      type: 'string',
      description: `Data state (live mode only). One of: ${DATA_STATES.join(',')} (default: final)`,
    },
    'aggregation-type': {
      type: 'string',
      description: `Aggregation type (live mode only). One of: ${AGGREGATION_TYPES.join(',')}`,
    },
    'explain': {
      type: 'boolean',
      default: false,
      description: 'Print the request body / planned local SQL and exit without executing',
    },
    'profile': {
      type: 'boolean',
      default: false,
      description: 'Print a query timing breakdown (manifest list / file fetch / SQL run) to stderr (local mode only)',
    },
  },
  async run({ args }) {
    const ctxConfig = await loadConfig()
    const format = args.format ?? ctxConfig.defaultFormat ?? 'json'
    if (format !== 'json' && format !== 'csv' && format !== 'table') {
      logger.error('Invalid --format. Use table, json, or csv.')
      process.exit(1)
    }
    if (args.sql || args.schema) {
      await runSqlMode({
        mode: args.schema ? { kind: 'schema' } : { kind: 'sql', sql: String(args.sql) },
        site: args.site ? String(args.site) : undefined,
        output: args.output ? String(args.output) : undefined,
        format,
        quiet: Boolean(args.quiet),
        forceLive: Boolean(args.live),
        searchType: parseSearchType(args.type, '--type'),
      })
      return
    }

    const dimNames = await resolveDimensions(args)
    const windowFlags = await promptRange(args)
    const invalidWindow = checkWindowFlags(windowFlags)
    if (invalidWindow) {
      logger.error(invalidWindow.message)
      process.exit(1)
    }
    await promptFilters(args as Record<string, unknown>)
    const limitArg = String(args.limit ?? ctxConfig.defaultLimit ?? 1000)
    const rowLimit = Number(limitArg)
    if (!POSITIVE_INTEGER_RE.test(limitArg) || !Number.isSafeInteger(rowLimit) || rowLimit < 1) {
      logger.error('Invalid --limit. Use a positive safe integer, such as --limit 1000.')
      process.exit(1)
    }
    const filters = parseFilterArgs(args as Record<string, unknown>)
    const searchType = parseSearchType(args.type ?? ctxConfig.defaultSearchType, '--type')
    // The Store holds every search type; reading them together adds web and image rows into one total.
    const localSearchType: SearchType = searchType ?? 'web'
    const dataState = args['data-state']
      ? String(args['data-state'])
      : ctxConfig.defaultDataState
    const aggregationType = args['aggregation-type'] ? String(args['aggregation-type']) : undefined
    const filterDims = filterDimensions(filters)
    if (dataState && !DATA_STATES.includes(dataState as any)) {
      logger.error(`Invalid --data-state: ${dataState}. Allowed: ${DATA_STATES.join(', ')}`)
      process.exit(1)
    }
    if (aggregationType && !AGGREGATION_TYPES.includes(aggregationType as any)) {
      logger.error(`Invalid --aggregation-type: ${aggregationType}. Allowed: ${AGGREGATION_TYPES.join(', ')}`)
      process.exit(1)
    }

    const forceLive = Boolean(args.live)
    const resolvable = isDatasetResolvable(dimNames as Dimension[], filterDims)
    // Never answer live on our own here: the Store may hold the Site, and one run never mixes sources.
    if (!resolvable && !forceLive)
      throw new Error(`No Store table holds ${[...new Set([...dimNames, ...filterDims])].join(' with ')}. Remove a dimension or filter, or pass --live.`)
    const storeCtx = await createCommandContext({ needsStore: true })
    const store = storeCtx.store!
    let liveCtx: ReturnType<typeof createCommandContext> | undefined
    const connect = (): ReturnType<typeof createCommandContext> => (liveCtx ??= createCommandContext({ needsAuth: true, interactive: Boolean(args.interactive) }))
    const { site, siteHint, auth } = await resolveReadSite(storeCtx, args.site ? String(args.site) : undefined, { forceLive, connect })
    // Filtered dimensions pick the table too: `-d query --page /a` needs page_queries.
    const table = resolvable ? inferDataset(dimNames as Dimension[], filterDims) as TableName : undefined
    const states = site ? await readSiteStates(store, site) : []
    const anchor = forceLive || !table ? getLatestGscDate() : newestDoneDate(states, [table]) ?? getLatestGscDate()
    const { start: startDate, end: endDate } = windowOrExit(windowFlags, anchor)
    const req: RouteRequest = { site, siteHint, label: 'query', localCapable: resolvable, liveCapable: true, forceLive, argv: useCliRuntime().rawArgs }
    const needs: RouteNeed[] = table ? [{ kind: 'window', period: 'current', table, searchType: localSearchType, window: { start: startDate, end: endDate } }] : []
    const routeState = await readRouteState({ store, site, needs, states, auth })
    const route = decideRoute(req, routeState)
    const json = format === 'json'

    if (route.kind === 'live') {
      const live = await connect()
      const siteUrl = site ?? await live.resolveSite(undefined)
      const dimensionFilter = toLiveFilter(filters, siteUrl)
      if (args.explain) {
        const body: Record<string, unknown> = {
          startDate,
          endDate,
          dimensions: dimNames,
          rowLimit,
        }
        if (searchType)
          body.type = searchType
        if (dataState)
          body.dataState = dataState
        if (aggregationType)
          body.aggregationType = aggregationType
        if (dimensionFilter)
          body.dimensionFilterGroups = filterToGroups(dimensionFilter)
        console.log(JSON.stringify({ siteUrl, source: 'live', body }, null, 2))
        return
      }
      if (route.reason === 'no-store-data')
        logger.warn(liveNote(siteUrl))
      if (!args.quiet)
        logger.debug(`Querying ${siteUrl} via live GSC API...`)
      const result = await runLiveQuery(live.client!, siteUrl, {
        startDate,
        endDate,
        dimensions: dimNames,
        rowLimit,
        searchType,
        dataState,
        aggregationType,
        dimensionFilter,
      })
      await writeOutput({
        output: {
          siteUrl,
          dimensions: dimNames,
          dateRange: { start: startDate, end: endDate },
          total: result.rows.length,
          data: result.rows,
          meta: { source: 'live' },
        },
        format,
        path: args.output ? String(args.output) : undefined,
        quiet: Boolean(args.quiet),
      })
      return
    }

    const state = buildLocalState(dimNames, startDate, endDate, rowLimit, toLocalFilter(filters))
    if (args.explain) {
      // A plan preview never stops: it shows the stop the real run would hit.
      const stop = route.kind === 'local' ? undefined : describeStop(route, req, routeState.auth)
      console.log(JSON.stringify({ siteUrl: site ?? null, source: 'local', table, state, ...(stop ? { stop } : {}) }, null, 2))
      return
    }
    if (route.kind === 'syncing' || route.kind === 'prompt')
      stopAtRoute(route, req, routeState.auth, { json })

    if (dataState || aggregationType) {
      logger.warn('--data-state / --aggregation-type are ignored without --live')
    }

    const siteUrl = site!
    if (!args.quiet)
      logger.debug(`Querying ${siteUrl} from local Parquet store...`)
    const profiling = Boolean(args.profile)
    const probe = profiling ? collectSpans() : undefined
    const result = await store.engine.query(
      {
        userId: store.userId,
        siteId: store.siteIdFor(siteUrl),
        table: table!,
        searchType: localSearchType,
        ...(probe ? { profiler: probe.profiler } : {}),
      },
      state,
    ).catch((e: Error) => {
      logger.error(`Query failed: ${e.message}`)
      process.exit(1)
    })

    if (probe)
      logProfile(probe.spans)

    await writeOutput({
      output: {
        siteUrl,
        dimensions: dimNames,
        dateRange: { start: startDate, end: endDate },
        total: result.rows.length,
        data: result.rows,
        meta: { source: 'local' },
      },
      format,
      path: args.output ? String(args.output) : undefined,
      quiet: Boolean(args.quiet),
    })
  },
})

async function resolveDimensions(args: Record<string, unknown>): Promise<string[]> {
  if (args.dimensions != null) {
    const dimensions = String(args.dimensions).split(',').map(d => d.trim())
    if (dimensions.some(d => !(DIMENSIONS as readonly string[]).includes(d))) {
      logger.error(`Invalid --dimensions. Use a comma-separated list from: ${DIMENSIONS.join(', ')}.`)
      process.exit(1)
    }
    return [...new Set(dimensions)]
  }

  if (args.interactive) {
    const selected = await multiselect({
      message: 'Select dimensions',
      options: DIMENSIONS.map(d => ({ value: d, label: d })),
      initialValues: ['page', 'query'],
    })
    if (isCancel(selected)) {
      cancel('Cancelled')
      process.exit(0)
    }
    return selected as string[]
  }

  return ['page', 'query']
}

/** Collect `--start`/`--end`, prompting for them in interactive mode. */
async function promptRange(args: Record<string, unknown>): Promise<WindowFlags> {
  let start = args.start != null ? String(args.start) : undefined
  let end = args.end != null ? String(args.end) : undefined
  if (args.interactive) {
    if (start === undefined) {
      const startInput = await text({
        message: 'Start date (YYYY-MM-DD, blank for the last 28 synced days)',
        placeholder: '',
      })
      if (isCancel(startInput)) {
        cancel('Cancelled')
        process.exit(0)
      }
      start = String(startInput) || undefined
    }
    if (end === undefined) {
      const endInput = await text({
        message: 'End date (YYYY-MM-DD, blank for the newest synced day)',
        placeholder: '',
      })
      if (isCancel(endInput)) {
        cancel('Cancelled')
        process.exit(0)
      }
      end = String(endInput) || undefined
    }
  }
  return { start, end }
}

function windowOrExit(flags: WindowFlags, anchor: string): { start: string, end: string } {
  const window = parseWindowFlags(flags, DEFAULT_WINDOW, anchor)
  if (!window.ok) {
    logger.error(window.error.message)
    process.exit(1)
  }
  return window.value
}

// Interactive mode fills in args.query/page/country/device/searchAppearance/type/data-state
// from prompts when the user hasn't already passed them. Mutates `args` in place.
async function promptFilters(args: Record<string, unknown>): Promise<void> {
  if (!args.interactive)
    return
  for (const dim of FILTER_DIMS) {
    if (args[dim])
      continue
    const v = await text({
      message: `Filter by ${dim} (blank to skip; prefix ~ for contains, ! for not-equals, re: for regex)`,
      placeholder: '',
    })
    if (isCancel(v)) {
      cancel('Cancelled')
      process.exit(0)
    }
    if (v && String(v).length > 0)
      args[dim] = String(v)
  }
  if (!args.type) {
    const t = await text({
      message: `Search type (blank for default web; allowed: ${ALL_SEARCH_TYPES.join(', ')})`,
      placeholder: '',
    })
    if (isCancel(t)) {
      cancel('Cancelled')
      process.exit(0)
    }
    if (t && String(t).length > 0)
      args.type = String(t)
  }
  if (!args['data-state']) {
    const ds = await text({
      message: `Data state (blank for default 'final'; allowed: ${DATA_STATES.join(', ')})`,
      placeholder: '',
    })
    if (isCancel(ds)) {
      cancel('Cancelled')
      process.exit(0)
    }
    if (ds && String(ds).length > 0)
      args['data-state'] = String(ds)
  }
}

function buildLocalState(
  dimNames: string[],
  startDate: string,
  endDate: string,
  rowLimit: number,
  dimensionFilter?: Filter<any>,
): BuilderState {
  const dims = dimNames
    .map(d => DIM_COLUMNS[d as DimensionName])
    .filter((c): c is Column<Dimension> => Boolean(c))

  const dateFilter = between(dateCol, startDate, endDate)
  const filter = dimensionFilter ? and(dateFilter, dimensionFilter) : dateFilter

  return (gsc
    .select(...(dims as [Column<Dimension>, ...Column<Dimension>[]]))
    .where(filter)
    .limit(rowLimit)
  )
    .getState()
}

type SqlMode
  = | { kind: 'sql', sql: string }
    | { kind: 'schema' }

async function runSqlMode(opts: {
  mode: SqlMode
  site: string | undefined
  output: string | undefined
  format: 'json' | 'csv' | 'table'
  quiet: boolean
  forceLive: boolean
  searchType?: SearchType
}): Promise<void> {
  // The views cover every Site in the Store. Only --site needs the Site resolver.
  const ctx = await createCommandContext({ needsStore: true })
  const store = ctx.store!
  const found = opts.site ? await ctx.matchSite(opts.site, { scope: 'store' }) : undefined
  if (found && found.kind !== 'resolved' && found.kind !== 'not-found')
    throw new Error(formatSiteResolution(found, 'store'))
  const site = found?.kind === 'resolved' ? found.siteUrl : undefined
  const siteIds = site ? [store.siteIdFor(site)] : opts.site ? [] : undefined
  const views = await openSqlViews(store, {
    ...(siteIds ? { siteIds } : {}),
    ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
  })
  if (opts.mode.kind === 'sql') {
    // Raw SQL reads the Store only. It stops when no view it names holds data.
    const tables = referencedTables(opts.mode.sql, allTables())
    if (tables.length > 0) {
      const req: RouteRequest = { site, siteHint: opts.site, label: 'query --sql', localCapable: true, liveCapable: false, forceLive: opts.forceLive }
      const routeState = await readRouteState({ store, site, needs: [], states: [] })
      const stored = tables.some(table => !views.emptyTables.includes(table))
      const route = decideRoute(req, { ...routeState, coverage: [{ kind: 'any', tables, stored }] })
      if (route.kind === 'syncing' || route.kind === 'prompt') {
        views.close()
        stopAtRoute(route, req, routeState.auth, { json: opts.format === 'json' })
      }
    }
  }
  try {
    const result = opts.mode.kind === 'schema'
      ? await describeViews(views)
      : await runSql(views, opts.mode.sql)
    const rows = result.rows
    const payload = opts.format === 'table' && opts.mode.kind === 'schema'
      ? renderSchema(rows)
      : opts.format === 'table'
        ? renderTable(rows, columnsFor(rows), terminalOutputOptions(Boolean(opts.output && opts.output !== '-'))).join('\n')
        : opts.format === 'csv'
          ? toCSV(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value !== null && typeof value === 'object' ? JSON.stringify(value) : value]))), result.columns)
          : JSON.stringify({ total: rows.length, data: rows, ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}) }, null, 2)
    if (opts.output && opts.output !== '-') {
      await fs.writeFile(opts.output, payload)
      if (!opts.quiet)
        logger.info(`Written to ${opts.output}`)
    }
    else {
      console.log(payload)
    }
  }
  finally {
    views.close()
  }
}

async function runSql(views: SqlViews, sql: string): Promise<SqlResult & { warnings: string[] }> {
  const warnings = referencedTables(sql, views.emptyTables)
    .map(table => `No synced data for table ${table}. Run gscdump sync --tables ${table} to fill it.`)
  for (const warning of warnings)
    logger.warn(warning)
  const result = await views.run(sql).catch((e: Error) => {
    logger.error(`SQL failed: ${e.message}`)
    process.exit(1)
  })
  return { ...result, warnings }
}

/** Human `--schema` output: one line per view, then its columns. A table would cut the column list. */
function renderSchema(rows: ReadonlyArray<Record<string, unknown>>): string {
  return rows.map((row) => {
    const summary = row.rows === 0
      ? 'no synced data'
      : `${Number(row.rows).toLocaleString()} rows, ${row.start} to ${row.end}, ${row.search_types}, ${row.sites}`
    return `${row.view}  ${summary}\n  ${row.columns}`
  }).join('\n')
}

/** One row per view: its columns, the Sites and search types it holds, and its date range. */
async function describeViews(views: SqlViews): Promise<SqlResult & { warnings: string[] }> {
  const rows: Array<Record<string, unknown>> = []
  for (const view of views.views) {
    const range = view.sources.length === 0
      ? { start: null, end: null }
      : (await views.run(`SELECT min(date) AS start, max(date) AS end FROM ${view.table}`)).rows[0]!
    rows.push({
      view: view.table,
      columns: view.columns.map(column => `${column.name} ${column.type}`).join(', '),
      sites: [...new Set(view.sources.map(source => source.site))].join(', '),
      search_types: [...new Set(view.sources.map(source => source.searchType))].join(', '),
      rows: view.sources.reduce((sum, source) => sum + source.rows, 0),
      start: range.start ?? null,
      end: range.end ?? null,
    })
  }
  return { columns: ['view', 'columns', 'sites', 'search_types', 'rows', 'start', 'end'], rows, warnings: [] }
}

/**
 * Render a `--profile` timing breakdown to stderr (via `logger`, so it never
 * mixes into the JSON/CSV stdout payload). Spans arrive in completion order:
 * `manifest.list` (object-key lookup), then the executor's `files.register`
 * (parquet fetch + DuckDB vFS registration — `buffered` is the count that took
 * the serial read path) and `query.run` (SQL execution), then the
 * `executor.execute` wrapper. `manifest.list` + `executor.execute` are the two
 * non-overlapping top-level slices, so their sum is the wall-clock total.
 */
function logProfile(spans: QuerySpan[]): void {
  if (spans.length === 0) {
    logger.warn('No profiling spans recorded (the executor may not be instrumented).')
    return
  }
  const fmtMeta = (m?: QuerySpan['meta']): string =>
    m ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ') : ''
  const row = (name: string, ms: number, meta?: QuerySpan['meta']): string =>
    `  ${name.padEnd(18)} ${`${ms}ms`.padStart(8)}  ${fmtMeta(meta)}`.trimEnd()
  const lines = spans.map(s => row(s.name, s.ms, s.meta))
  const total = spans
    .filter(s => s.name === 'manifest.list' || s.name === 'executor.execute')
    .reduce((n, s) => n + s.ms, 0)
  logger.info(`Query timing breakdown:\n${lines.join('\n')}\n${row('total', total)}`)
}

async function writeOutput(opts: {
  output: { dimensions: string[], data: Record<string, unknown>[], [key: string]: unknown }
  format: 'json' | 'csv' | 'table'
  path: string | undefined
  quiet: boolean
}): Promise<void> {
  const range = asRecord(opts.output.dateRange)
  const content = opts.format === 'table'
    ? renderQuery({ site: String(opts.output.siteUrl), start: String(range.start), end: String(range.end), dimensions: opts.output.dimensions, rows: opts.output.data }, terminalOutputOptions(Boolean(opts.path && opts.path !== '-')))
    : opts.format === 'csv'
      ? toCSV(opts.output.data, [...opts.output.dimensions, 'clicks', 'impressions', 'ctr', 'position'])
      : JSON.stringify(opts.output, null, 2)
  // `--output -` is the conventional stdout sentinel; everything else is a path.
  if (opts.path && opts.path !== '-') {
    await fs.writeFile(opts.path, content)
    if (!opts.quiet)
      logger.info(`Written to ${opts.path}`)
  }
  else {
    console.log(content)
  }
}
