import type { Dimension } from 'gscdump/query'
import fs from 'node:fs/promises'
import process from 'node:process'
import { cancel, isCancel, multiselect, select, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump'
import { between, country, date, device, gsc, page, query, searchAppearance } from 'gscdump/query'
import { loadConfig } from '../config'
import { clearLine, exportToCSV, logger, progressBar } from '../utils'

const DIMENSION_MAP: Record<string, Dimension> = {
  page,
  query,
  date,
  country,
  device,
  searchAppearance,
}

export const queryCommand = defineCommand({
  meta: {
    name: 'query',
    description: 'Run custom search analytics queries',
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
      description: 'Dimensions: page,query,date,country,device,searchAppearance',
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
    const { getAuth } = await import('../auth')
    const auth = await getAuth({ interactive: false, config })
    const client = googleSearchConsole(auth)

    // Resolve site
    let siteUrl = String(args.site || config.defaultSite || '')

    if (!siteUrl || args.interactive) {
      const sites = await client.sites()
      const verified = sites.filter(s => s.permissionLevel !== 'siteUnverifiedUser')

      if (verified.length === 0) {
        logger.error('No verified sites found')
        process.exit(1)
      }

      const selected = await select({
        message: 'Select a site',
        options: verified.map(s => ({ value: s.siteUrl!, label: s.siteUrl! })),
        initialValue: siteUrl || verified[0]?.siteUrl,
      })

      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }
      siteUrl = selected as string
    }

    // Resolve dimensions
    let dimensions: Dimension[]

    if (args.dimensions) {
      const dimNames = String(args.dimensions).split(',')
      dimensions = dimNames
        .filter(d => d in DIMENSION_MAP)
        .map(d => DIMENSION_MAP[d])
    }
    else if (args.interactive) {
      const selected = await multiselect({
        message: 'Select dimensions',
        options: Object.keys(DIMENSION_MAP).map(d => ({ value: d, label: d })),
        initialValues: ['page', 'query'],
      })
      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }
      dimensions = (selected as string[]).map(d => DIMENSION_MAP[d])
    }
    else {
      dimensions = [page, query]
    }

    // Resolve date range
    let startDate: string
    let endDate: string

    if (args.start && args.end) {
      startDate = String(args.start)
      endDate = String(args.end)
    }
    else if (args.interactive) {
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

      startDate = String(startInput) || new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0]
      endDate = String(endInput) || new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]
    }
    else {
      endDate = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]
      startDate = new Date(Date.now() - 31 * 86400000).toISOString().split('T')[0]
    }

    const rowLimit = Number.parseInt(String(args.limit), 10)
    const format = String(args.format) as 'json' | 'csv'

    // Build and execute query
    const builder = gsc
      .select(...dimensions)
      .where(between(date, startDate, endDate))
      .limit(rowLimit)

    if (!args.quiet) {
      logger.info(`Querying ${siteUrl}...`)
    }

    const rows: Record<string, unknown>[] = []

    for await (const batch of client.query(siteUrl, builder)) {
      rows.push(...batch)
      if (!args.quiet) {
        clearLine()
        process.stdout.write(progressBar(rows.length, rowLimit, `${rows.length} rows`))
      }
    }

    if (!args.quiet) {
      clearLine()
      logger.success(`Fetched ${rows.length} rows`)
    }

    // Output
    const output = {
      siteUrl,
      dimensions: dimensions.map(d => String(d)),
      dateRange: { start: startDate, end: endDate },
      total: rows.length,
      data: rows,
    }

    const content = format === 'csv'
      ? exportToCSV(output)
      : JSON.stringify(output, null, 2)

    if (args.output) {
      await fs.writeFile(String(args.output), content)
      if (!args.quiet) {
        logger.info(`Written to ${args.output}`)
      }
    }
    else {
      console.log(content)
    }
  },
})
