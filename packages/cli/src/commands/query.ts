import type { Dimension } from 'gscdump/query'
import type { CloudClient, CloudMeSite } from '../cloud'
import fs from 'node:fs/promises'
import process from 'node:process'
import { cancel, isCancel, multiselect, select, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump'
import { between, country, date, device, gsc, page, query, searchAppearance } from 'gscdump/query'
import { getAuth, getCloudClient } from '../auth'
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

async function resolveCloudSite(cloud: CloudClient, target?: string): Promise<{ siteId: string, siteUrl: string }> {
  const me = await cloud.me().catch((e: Error) => {
    logger.error(`Failed to fetch sites: ${e.message}`)
    process.exit(1)
  })

  if (me.sites.length === 0) {
    logger.error('No registered sites. Run gscdump register first.')
    process.exit(1)
  }

  let site: CloudMeSite | undefined = target
    ? me.sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
    : undefined

  if (!site) {
    if (me.sites.length === 1) {
      site = me.sites[0]
    }
    else {
      const selected = await select({
        message: 'Select a site',
        options: me.sites.map(s => ({ value: s.siteId, label: s.siteUrl })),
      })
      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }
      site = me.sites.find(s => s.siteId === selected)!
    }
  }

  return { siteId: site.siteId, siteUrl: site.siteUrl }
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

    // Resolve dimensions (shared by cloud and local)
    let dimNames: string[]

    if (args.dimensions) {
      dimNames = String(args.dimensions).split(',').filter(d => d in DIMENSION_MAP)
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
      dimNames = selected as string[]
    }
    else {
      dimNames = ['page', 'query']
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

    // Cloud mode
    const cloud = await getCloudClient()
    if (cloud) {
      const { siteId, siteUrl } = await resolveCloudSite(cloud, args.site || config.defaultSite)

      if (!args.quiet) {
        logger.info(`Querying ${siteUrl}...`)
      }

      const result = await cloud.query(siteId, {
        startDate,
        endDate,
        dimensions: dimNames.join(','),
        rowLimit: String(rowLimit),
      }).catch((e: Error) => {
        logger.error(`Query failed: ${e.message}`)
        process.exit(1)
      })

      if (!args.quiet) {
        logger.success(`Fetched ${result.rows.length} rows`)
      }

      const output = {
        siteUrl,
        dimensions: dimNames,
        dateRange: { start: startDate, end: endDate },
        total: result.rows.length,
        data: result.rows,
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
      return
    }

    // Local mode
    const auth = await getAuth({ interactive: false, config })
    const client = googleSearchConsole(auth)
    const dimensions: Dimension[] = dimNames.map(d => DIMENSION_MAP[d])

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

    const output = {
      siteUrl,
      dimensions: dimNames,
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
