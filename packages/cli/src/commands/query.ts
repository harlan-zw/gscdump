import type { TableName } from 'gscdump/analytics/contracts'
import type { BuilderState, Column, Dimension } from 'gscdump/query'
import fs from 'node:fs/promises'
import process from 'node:process'
import { cancel, isCancel, multiselect, select, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump'
import { allTables, inferTable } from 'gscdump/analytics/schema'
import { between, country, date as dateCol, device, gsc, page, query as queryCol, searchAppearance } from 'gscdump/query'
import { createAnalyticsHarness } from '../analytics'
import { getAuth } from '../auth'
import { loadConfig } from '../config'
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

interface GscSite {
  siteUrl: string
  permissionLevel: string
}

async function loadSites(client: ReturnType<typeof googleSearchConsole>): Promise<GscSite[]> {
  const gscSites = await client.sites().catch((e: Error) => {
    logger.error(`Failed to fetch sites: ${e.message}`)
    process.exit(1)
  })
  return gscSites
    .filter(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
    .map(s => ({ siteUrl: s.siteUrl!, permissionLevel: s.permissionLevel || 'unknown' }))
}

async function resolveSiteUrl(sites: GscSite[], target?: string): Promise<string> {
  if (target) {
    const match = sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
    if (match)
      return match.siteUrl
  }
  if (sites.length === 1)
    return sites[0].siteUrl

  const selected = await select({
    message: 'Select a site',
    options: sites.map(s => ({ value: s.siteUrl, label: s.siteUrl })),
  })
  if (isCancel(selected)) {
    cancel('Cancelled')
    process.exit(0)
  }
  return selected as string
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
    const config = await loadConfig()

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

    const auth = await getAuth({ interactive: Boolean(args.interactive), config })
    const client = googleSearchConsole(auth)
    const sites = await loadSites(client)
    if (sites.length === 0) {
      logger.error('No sites found')
      process.exit(1)
    }
    const siteUrl = await resolveSiteUrl(sites, String(args.site || config.defaultSite || ''))

    if (args.live) {
      if (!args.quiet)
        logger.info(`Querying ${siteUrl} via live GSC API...`)
      const result = await runLiveQuery(client, siteUrl, {
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
    const harness = createAnalyticsHarness(config)
    const table = inferTable(dimNames)
    await assertRangeCovered(harness, siteUrl, table, startDate, endDate)
    const result = await harness.engine.query(
      { userId: harness.userId, siteId: harness.siteIdFor(siteUrl), table },
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
      placeholder: new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0],
    })
    if (isCancel(startInput)) {
      cancel('Cancelled')
      process.exit(0)
    }
    const endInput = await text({
      message: 'End date (YYYY-MM-DD)',
      placeholder: new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0],
    })
    if (isCancel(endInput)) {
      cancel('Cancelled')
      process.exit(0)
    }
    return {
      startDate: String(startInput) || new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0],
      endDate: String(endInput) || new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0],
    }
  }

  return {
    startDate: new Date(Date.now() - 31 * 86400000).toISOString().split('T')[0],
    endDate: new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0],
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
  harness: ReturnType<typeof createAnalyticsHarness>,
  siteUrl: string,
  table: TableName,
  startDate: string,
  endDate: string,
): Promise<void> {
  const watermarks = await harness.engine.getWatermarks({
    userId: harness.userId,
    siteId: harness.siteIdFor(siteUrl),
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
  const config = await loadConfig()
  if (!isKnownTable(opts.table)) {
    logger.error(`Unknown table "${opts.table}". Known: ${allTables().join(', ')}`)
    process.exit(1)
  }

  const auth = await getAuth({ interactive: false, config })
  const client = googleSearchConsole(auth)
  const sites = await loadSites(client)
  const siteUrl = await resolveSiteUrl(sites, opts.site || config.defaultSite)

  const harness = createAnalyticsHarness(config)
  if (!opts.quiet)
    logger.info(`Running raw SQL over table "${opts.table}" for ${siteUrl}`)

  const { rows, sql } = await harness.runRawSql({
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
