import type { QuerySpan } from '@gscdump/engine/profile'
import type { googleSearchConsole } from 'gscdump/client'
import type { BuilderState, Column, Dimension, Filter, SearchType } from 'gscdump/query'
import type { LocalStore, TableName } from '../local-store'
import fs from 'node:fs/promises'
import process from 'node:process'
import { cancel, isCancel, multiselect, text } from '@clack/prompts'
import { collectSpans } from '@gscdump/engine/profile'
import { defineCommand } from 'citty'
import { daysAgoUtc as daysAgo } from 'gscdump/dates'
import { and, between, contains, country, date as dateCol, device, eq, gsc, hour, notRegex, page, query as queryCol, regex, searchAppearance } from 'gscdump/query'
import { queryCommandMeta } from '../command-meta'
import { loadConfig } from '../config'
import { createCommandContext } from '../context'
import { gscErrorHandler } from '../error-handler'
import { allTables, inferTable, tableDimensions } from '../local-store'
import { asRecord, columnsFor } from '../render/analysis'
import { renderTable } from '../render/layout'
import { renderQuery } from '../render/query'
import { terminalOutputOptions } from '../render/terminal'
import { ALL_SEARCH_TYPES, logger, parseSearchType, toCSV } from '../utils'

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

const FILTER_DIMS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const
type FilterDim = typeof FILTER_DIMS[number]
const FILTER_COL: Record<FilterDim, Column<Dimension>> = {
  query: queryCol,
  page,
  country,
  device,
  searchAppearance,
}
const DATA_STATES = ['all', 'final', 'hourly_all'] as const
const AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty'] as const
const POSITIVE_INTEGER_RE = /^\d+$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Filter expression prefixes for `--query`, `--page`, `--country`, `--device`,
// `--search-appearance`. Bare values default to equals.
//   ~foo         contains
//   !~foo        not contains
//   re:foo       regex
//   !re:foo      not regex
//   contains:foo contains (verbose form)
//   eq:foo       equals (verbose form)
//   !foo         not equals
function buildFilterFromArg(col: Column<Dimension>, raw: string): Filter<any> {
  if (raw.startsWith('!~'))
    return makeLeaf(col, 'notContains', raw.slice(2))
  if (raw.startsWith('!re:'))
    return notRegex(col as Column<'page'>, raw.slice(4))
  if (raw.startsWith('!'))
    return makeLeaf(col, 'notEquals', raw.slice(1))
  if (raw.startsWith('~'))
    return contains(col as Column<'page'>, raw.slice(1))
  if (raw.startsWith('re:'))
    return regex(col as Column<'page'>, raw.slice(3))
  if (raw.startsWith('contains:'))
    return contains(col as Column<'page'>, raw.slice(9))
  if (raw.startsWith('eq:'))
    return eq(col as Column<'page'>, raw.slice(3) as any)
  return eq(col as Column<'page'>, raw as any)
}

function makeLeaf(col: Column<Dimension>, operator: 'notEquals' | 'notContains', value: string): Filter<any> {
  return {
    _constraints: {},
    _filters: [{ dimension: col.dimension, operator, expression: value }],
  } as unknown as Filter<any>
}

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
      description: 'Site URL (e.g., sc-domain:example.com)',
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
      description: 'Raw DuckDB SQL using {{FILES}} as the file list placeholder (bypasses builder)',
    },
    'table': {
      type: 'string',
      description: 'Analytics table for --sql (default: pages)',
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
      description: `Search type (live mode only). One of: ${ALL_SEARCH_TYPES.join(',')}`,
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
    if (args.sql) {
      await runRawSqlMode({
        sql: String(args.sql),
        site: args.site ? String(args.site) : undefined,
        table: args.table ? String(args.table) : 'pages',
        output: args.output ? String(args.output) : undefined,
        format,
        quiet: Boolean(args.quiet),
        searchType: parseSearchType(args.type, '--type'),
      })
      return
    }

    const dimNames = await resolveDimensions(args)
    const { startDate, endDate } = await resolveRange(args)
    await promptFilters(args as Record<string, unknown>)
    const limitArg = String(args.limit ?? ctxConfig.defaultLimit ?? 1000)
    const rowLimit = Number(limitArg)
    if (!POSITIVE_INTEGER_RE.test(limitArg) || !Number.isSafeInteger(rowLimit) || rowLimit < 1) {
      logger.error('Invalid --limit. Use a positive safe integer, such as --limit 1000.')
      process.exit(1)
    }
    const dimensionFilter = buildDimensionFilter(args)
    const searchType = parseSearchType(args.type ?? ctxConfig.defaultSearchType, '--type')
    const dataState = args['data-state']
      ? String(args['data-state'])
      : ctxConfig.defaultDataState
    const aggregationType = args['aggregation-type'] ? String(args['aggregation-type']) : undefined

    if (dataState && !DATA_STATES.includes(dataState as any)) {
      logger.error(`Invalid --data-state: ${dataState}. Allowed: ${DATA_STATES.join(', ')}`)
      process.exit(1)
    }
    if (aggregationType && !AGGREGATION_TYPES.includes(aggregationType as any)) {
      logger.error(`Invalid --aggregation-type: ${aggregationType}. Allowed: ${AGGREGATION_TYPES.join(', ')}`)
      process.exit(1)
    }

    const ctx = await createCommandContext({
      needsAuth: true,
      needsStore: !args.live,
      interactive: Boolean(args.interactive),
    })
    const hint = args.site ? String(args.site) : ctx.config.defaultSite
    // An exact local Site identifies files already owned by this Store.
    // Only live reads and shorthand discovery need Google's Site listing.
    const siteUrl = !args.live && hint && /^(?:sc-domain:\S+|https?:\/\/\S+)$/.test(hint)
      ? hint
      : await ctx.resolveSite(hint)

    if (args.live) {
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
        console.log(JSON.stringify({ siteUrl, body }, null, 2))
        return
      }
      if (!args.quiet)
        logger.debug(`Querying ${siteUrl} via live GSC API...`)
      const result = await runLiveQuery(ctx.client!, siteUrl, {
        startDate,
        endDate,
        dimensions: dimNames,
        rowLimit,
        searchType,
        dataState,
        aggregationType,
        dimensionFilter,
      }).catch(gscErrorHandler)
      await writeOutput({
        output: {
          siteUrl,
          dimensions: dimNames,
          dateRange: { start: startDate, end: endDate },
          total: result.rows.length,
          data: result.rows,
        },
        format,
        path: args.output ? String(args.output) : undefined,
        quiet: Boolean(args.quiet),
      })
      return
    }

    if (dataState || aggregationType) {
      logger.warn('--data-state / --aggregation-type are ignored without --live')
    }

    if (!args.quiet)
      logger.debug(`Querying ${siteUrl} from local Parquet store...`)

    const state = buildLocalState(dimNames, startDate, endDate, rowLimit, dimensionFilter)
    const store = ctx.store!
    const table = inferTable(dimNames)
    if (args.explain) {
      console.log(JSON.stringify({ siteUrl, table, state }, null, 2))
      return
    }
    await assertRangeCovered(store, siteUrl, table, startDate, endDate, format === 'json', searchType)
    const profiling = Boolean(args.profile)
    const probe = profiling ? collectSpans() : undefined
    const result = await store.engine.query(
      {
        userId: store.userId,
        siteId: store.siteIdFor(siteUrl),
        table,
        ...(searchType !== undefined ? { searchType } : {}),
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

async function resolveRange(args: Record<string, unknown>): Promise<{ startDate: string, endDate: string }> {
  let startDate = args.start != null ? String(args.start) : undefined
  let endDate = args.end != null ? String(args.end) : undefined
  if (args.interactive) {
    if (startDate === undefined) {
      const startInput = await text({
        message: 'Start date (YYYY-MM-DD)',
        placeholder: daysAgo(28),
      })
      if (isCancel(startInput)) {
        cancel('Cancelled')
        process.exit(0)
      }
      startDate = String(startInput) || daysAgo(28)
    }
    if (endDate === undefined) {
      const endInput = await text({
        message: 'End date (YYYY-MM-DD)',
        placeholder: daysAgo(3),
      })
      if (isCancel(endInput)) {
        cancel('Cancelled')
        process.exit(0)
      }
      endDate = String(endInput) || daysAgo(3)
    }
  }

  startDate ??= daysAgo(31)
  endDate ??= daysAgo(3)
  for (const [flag, value] of [['--start', startDate], ['--end', endDate]]) {
    const date = new Date(`${value}T00:00:00Z`)
    if (!ISO_DATE_RE.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      logger.error(`Invalid ${flag}. Use a calendar date in YYYY-MM-DD format.`)
      process.exit(1)
    }
  }
  if (startDate > endDate) {
    logger.error('Invalid date range. --start must be on or before --end.')
    process.exit(1)
  }
  return { startDate, endDate }
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

function buildDimensionFilter(args: Record<string, unknown>): Filter<any> | undefined {
  const leaves: Filter<any>[] = []
  for (const dim of FILTER_DIMS) {
    const raw = args[dim]
    if (raw == null || raw === '')
      continue
    leaves.push(buildFilterFromArg(FILTER_COL[dim], String(raw)))
  }
  if (leaves.length === 0)
    return undefined
  if (leaves.length === 1)
    return leaves[0]
  return and(...leaves)
}

async function assertRangeCovered(
  store: LocalStore,
  siteUrl: string,
  table: TableName,
  startDate: string,
  endDate: string,
  json: boolean,
  searchType?: SearchType,
): Promise<void> {
  const watermarks = await store.engine.getWatermarks({
    userId: store.userId,
    siteId: store.siteIdFor(siteUrl),
    table,
    ...(searchType !== undefined ? { searchType } : {}),
  })
  const wm = watermarks[0]
  const states = await store.engine.getSyncStates({
    userId: store.userId,
    siteId: store.siteIdFor(siteUrl),
    table,
    searchType: searchType ?? 'web',
    state: 'done',
  })
  const completed = new Set(states.map(state => state.date))
  const missingDates: string[] = []
  for (let date = Date.parse(startDate); date <= Date.parse(endDate); date += 86400_000) {
    const day = new Date(date).toISOString().slice(0, 10)
    if (!completed.has(day))
      missingDates.push(day)
  }
  if (missingDates.length === 0)
    return
  const nextArgs = ['sync', '--site', siteUrl, '--start', startDate, '--end', endDate, '--tables', table, '--types', searchType ?? 'web', '--json']
  const nextCommand = `gscdump ${nextArgs.map(value => /^[\w:./=-]+$/.test(value) ? value : `'${value.replaceAll('\'', '\'\\\'\'')}'`).join(' ')}`
  const message = !wm
    ? `No data synced for ${siteUrl} / ${table}.`
    : `Store coverage is incomplete for ${missingDates.length} requested dates.`
  if (json) {
    const available = await store.engine.getWatermarks({ userId: store.userId, siteId: store.siteIdFor(siteUrl) })
    console.log(JSON.stringify({ error: {
      code: 'STORE_RANGE_NOT_COVERED',
      message,
      siteUrl,
      table,
      range: { start: startDate, end: endDate },
      missingDates,
      watermarks: watermarks.filter(w => w.table === table),
      availableTables: available.map(w => ({ ...w, dimensions: tableDimensions(w.table) })),
      nextArgs,
      nextCommand,
    } }, null, 2))
  }
  logger.error(`${message} Run ${nextCommand}, or pass --live.`)
  process.exit(1)
}

async function runRawSqlMode(opts: {
  sql: string
  site: string | undefined
  table: string
  output: string | undefined
  format: 'json' | 'csv' | 'table'
  quiet: boolean
  searchType?: SearchType
}): Promise<void> {
  if (!isKnownTable(opts.table)) {
    logger.error(`Unknown table "${opts.table}". Known: ${allTables().join(', ')}`)
    process.exit(1)
  }

  const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
  const siteUrl = await ctx.resolveSite(opts.site)
  const store = ctx.store!

  if (!opts.quiet)
    logger.debug(`Running raw SQL over table "${opts.table}" for ${siteUrl}`)

  const { rows, sql } = await store.runRawSql({
    sql: opts.sql,
    siteUrl,
    table: opts.table,
    ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
  }).catch((e: Error) => {
    logger.error(`SQL failed: ${e.message}`)
    process.exit(1)
  })

  const payload = opts.format === 'table'
    ? renderTable(rows, columnsFor(rows), terminalOutputOptions(Boolean(opts.output && opts.output !== '-'))).join('\n')
    : opts.format === 'csv'
      ? toCSV(rows, Object.keys(rows[0] ?? {}))
      : JSON.stringify(
          { sql, total: rows.length, data: rows },
          (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value,
          2,
        )
  if (opts.output && opts.output !== '-') {
    await fs.writeFile(opts.output, payload)
    if (!opts.quiet)
      logger.info(`Written to ${opts.output}`)
  }
  else {
    console.log(payload)
  }
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

function isKnownTable(name: string): name is TableName {
  return (allTables() as readonly string[]).includes(name)
}
