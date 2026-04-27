import type { googleSearchConsole } from 'gscdump'
import type { BuilderState, Column, Dimension } from 'gscdump/query'
import type { LocalStore, TableName } from '../local-store'
import fs from 'node:fs/promises'
import process from 'node:process'
import { cancel, isCancel, multiselect, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { daysAgo } from 'gscdump'
import { between, country, date as dateCol, device, gsc, page, query as queryCol, searchAppearance } from 'gscdump/query'
import { createCommandContext } from '../context'
import { allTables, inferTable } from '../local-store'
import { exportToCSV, logger } from '../utils'

const DIMENSIONS = ['page', 'query', 'date', 'country', 'device', 'searchAppearance'] as const
type DimensionName = typeof DIMENSIONS[number]

const DIM_COLUMNS: Record<DimensionName, Column<Dimension>> = {
  page,
  query: queryCol,
  date: dateCol,
  country,
  device,
  searchAppearance,
}

async function runLiveQuery(
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  opts: { startDate: string, endDate: string, dimensions: string[], rowLimit: number },
): Promise<{ rows: Record<string, unknown>[] }> {
  const allRows: Record<string, unknown>[] = []
  let startRow = 0

  while (true) {
    const response = await client._rawQuery(siteUrl, {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: opts.dimensions,
      rowLimit: opts.rowLimit,
      startRow,
    } as any)
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
    allRows.push(...rows)
    if (rows.length < opts.rowLimit)
      break
    startRow += rows.length
  }

  return { rows: allRows }
}

export const queryCommand = defineCommand({
  meta: {
    name: 'query',
    description: 'Run a search analytics query (local Parquet by default, --live hits GSC API)',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com)',
    },
    dimensions: {
      type: 'string',
      alias: 'd',
      description: `Dimensions: ${DIMENSIONS.join(',')}`,
    },
    start: {
      type: 'string',
      description: 'Start date (YYYY-MM-DD)',
    },
    end: {
      type: 'string',
      description: 'End date (YYYY-MM-DD)',
    },
    limit: {
      type: 'string',
      alias: 'l',
      default: '1000',
      description: 'Max rows (default: 1000)',
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output file path (default: stdout)',
    },
    format: {
      type: 'string',
      alias: 'f',
      default: 'json',
      description: 'Output format: json or csv',
    },
    sql: {
      type: 'string',
      description: 'Raw DuckDB SQL using {{FILES}} as the file list placeholder (bypasses builder)',
    },
    table: {
      type: 'string',
      description: 'Analytics table for --sql (default: pages)',
    },
    live: {
      type: 'boolean',
      default: false,
      description: 'Bypass local store; hit the GSC API directly',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress progress output',
    },
    interactive: {
      type: 'boolean',
      alias: 'i',
      default: false,
      description: 'Interactive mode',
    },
  },
  async run({ args }) {
    if (args.sql) {
      await runRawSqlMode({
        sql: String(args.sql),
        site: args.site ? String(args.site) : undefined,
        table: args.table ? String(args.table) : 'pages',
        output: args.output ? String(args.output) : undefined,
        quiet: Boolean(args.quiet),
      })
      return
    }

    const dimNames = await resolveDimensions(args)
    const { startDate, endDate } = await resolveRange(args)
    const rowLimit = Number.parseInt(String(args.limit), 10)
    const format = String(args.format) as 'json' | 'csv'

    const ctx = await createCommandContext({
      needsAuth: true,
      needsStore: !args.live,
      interactive: Boolean(args.interactive),
    })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)

    if (args.live) {
      if (!args.quiet)
        logger.info(`Querying ${siteUrl} via live GSC API...`)
      const result = await runLiveQuery(ctx.client!, siteUrl, {
        startDate,
        endDate,
        dimensions: dimNames,
        rowLimit,
      }).catch((e: Error) => {
        logger.error(`Query failed: ${e.message}`)
        process.exit(1)
      })
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

    if (!args.quiet)
      logger.info(`Querying ${siteUrl} from local Parquet store...`)

    const state = buildLocalState(dimNames, startDate, endDate, rowLimit)
    const store = ctx.store!
    const table = inferTable(dimNames)
    await assertRangeCovered(store, siteUrl, table, startDate, endDate)
    const result = await store.engine.query(
      { userId: store.userId, siteId: store.siteIdFor(siteUrl), table },
      state,
    ).catch((e: Error) => {
      logger.error(`Query failed: ${e.message}`)
      process.exit(1)
    })

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
  if (args.dimensions)
    return String(args.dimensions).split(',').filter(d => (DIMENSIONS as readonly string[]).includes(d))

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
  if (args.start && args.end)
    return { startDate: String(args.start), endDate: String(args.end) }

  if (args.interactive) {
    const startInput = await text({
      message: 'Start date (YYYY-MM-DD)',
      placeholder: daysAgo(28),
    })
    if (isCancel(startInput)) {
      cancel('Cancelled')
      process.exit(0)
    }
    const endInput = await text({
      message: 'End date (YYYY-MM-DD)',
      placeholder: daysAgo(3),
    })
    if (isCancel(endInput)) {
      cancel('Cancelled')
      process.exit(0)
    }
    return {
      startDate: String(startInput) || daysAgo(28),
      endDate: String(endInput) || daysAgo(3),
    }
  }

  return {
    startDate: daysAgo(31),
    endDate: daysAgo(3),
  }
}

function buildLocalState(
  dimNames: string[],
  startDate: string,
  endDate: string,
  rowLimit: number,
): BuilderState {
  const dims = dimNames
    .map(d => DIM_COLUMNS[d as DimensionName])
    .filter((c): c is Column<Dimension> => Boolean(c))

  return (gsc
    .select(...(dims as [Column<Dimension>, ...Column<Dimension>[]]))
    .where(between(dateCol, startDate, endDate))
    .limit(rowLimit)
  )
    .getState()
}

async function assertRangeCovered(
  store: LocalStore,
  siteUrl: string,
  table: TableName,
  startDate: string,
  endDate: string,
): Promise<void> {
  const watermarks = await store.engine.getWatermarks({
    userId: store.userId,
    siteId: store.siteIdFor(siteUrl),
    table,
  })
  const wm = watermarks[0]
  if (!wm) {
    logger.error(`No data synced for ${siteUrl} / ${table}. Run \`gscdump sync\` first, or pass --live.`)
    process.exit(1)
  }
  if (endDate > wm.newestDateSynced) {
    logger.error(`Requested end=${endDate} is newer than last sync (${wm.newestDateSynced}). Run \`gscdump sync\` first, or pass --live.`)
    process.exit(1)
  }
  if (startDate < wm.oldestDateSynced) {
    logger.error(`Requested start=${startDate} is older than first sync (${wm.oldestDateSynced}). Run \`gscdump sync --start=${startDate}\` first, or pass --live.`)
    process.exit(1)
  }
}

async function runRawSqlMode(opts: {
  sql: string
  site: string | undefined
  table: string
  output: string | undefined
  quiet: boolean
}): Promise<void> {
  if (!isKnownTable(opts.table)) {
    logger.error(`Unknown table "${opts.table}". Known: ${allTables().join(', ')}`)
    process.exit(1)
  }

  const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
  const siteUrl = await ctx.resolveSite(opts.site)
  const store = ctx.store!

  if (!opts.quiet)
    logger.info(`Running raw SQL over table "${opts.table}" for ${siteUrl}`)

  const { rows, sql } = await store.runRawSql({
    sql: opts.sql,
    siteUrl,
    table: opts.table,
  }).catch((e: Error) => {
    logger.error(`SQL failed: ${e.message}`)
    process.exit(1)
  })

  const payload = JSON.stringify({ sql, total: rows.length, data: rows }, null, 2)
  if (opts.output) {
    await fs.writeFile(opts.output, payload)
    if (!opts.quiet)
      logger.info(`Written to ${opts.output}`)
  }
  else {
    console.log(payload)
  }
}

async function writeOutput(opts: {
  output: Record<string, unknown>
  format: 'json' | 'csv'
  path: string | undefined
  quiet: boolean
}): Promise<void> {
  const content = opts.format === 'csv' ? exportToCSV(opts.output) : JSON.stringify(opts.output, null, 2)
  if (opts.path) {
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
