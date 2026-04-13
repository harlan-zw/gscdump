import type { TableName } from 'gscdump/analytics'
import type { DriverSite } from 'gscdump/driver'
import type { BuilderState, Column, Dimension } from 'gscdump/query'
import fs from 'node:fs/promises'
import process from 'node:process'
import { cancel, isCancel, multiselect, select, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { allTables, inferTable } from 'gscdump/analytics'
import { between, country, date as dateCol, device, gsc, page, query as queryCol, searchAppearance } from 'gscdump/query'
import { createAnalyticsHarness } from '../analytics'
import { loadConfig } from '../config'
import { getDriver } from '../driver'
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

async function resolveSiteUrl(sites: DriverSite[], target?: string): Promise<string> {
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

    const driver = await getDriver({ interactive: Boolean(args.interactive) })
    const sites = await driver.sites().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })
    if (sites.length === 0) {
      logger.error('No sites found')
      process.exit(1)
    }
    const siteUrl = await resolveSiteUrl(sites, String(args.site || config.defaultSite || ''))

    if (args.live || config.mode === 'cloud') {
      if (!args.quiet)
        logger.info(`Querying ${siteUrl} via live GSC API...`)
      const result = await driver.query(siteUrl, {
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

async function runRawSqlMode(opts: {
  sql: string
  site: string | undefined
  table: string
  output: string | undefined
  quiet: boolean
}): Promise<void> {
  const config = await loadConfig()
  if (config.mode === 'cloud') {
    logger.error('--sql only runs against the local Parquet store; cloud mode is not supported.')
    process.exit(1)
  }
  if (!isKnownTable(opts.table)) {
    logger.error(`Unknown table "${opts.table}". Known: ${allTables().join(', ')}`)
    process.exit(1)
  }

  const driver = await getDriver({ interactive: false })
  const sites = await driver.sites().catch((e: Error) => {
    logger.error(`Failed to fetch sites: ${e.message}`)
    process.exit(1)
  })
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
