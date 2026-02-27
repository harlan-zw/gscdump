import type { Dimension } from 'gscdump/query'
import type { CloudClient, CloudMeSite } from '../cloud'
import fs from 'node:fs/promises'
import process from 'node:process'
import { cancel, isCancel, multiselect, select, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump'
import { between, country, date, device, gsc, page, query } from 'gscdump/query'
import { getAuth, getCloudClient } from '../auth'
import { loadConfig } from '../config'
import { clearLine, exportToCSV, logger, progressBar } from '../utils'

const DUMP_DATA_TYPES = ['pages', 'keywords', 'countries', 'devices'] as const
type DumpDataType = typeof DUMP_DATA_TYPES[number]

function getDimensions(dataType: DumpDataType): Dimension[] {
  switch (dataType) {
    case 'pages': return [page, date]
    case 'keywords': return [query, date]
    case 'countries': return [country, date]
    case 'devices': return [device, date]
  }
}

function getDimensionNames(dataType: DumpDataType): string {
  switch (dataType) {
    case 'pages': return 'page,date'
    case 'keywords': return 'query,date'
    case 'countries': return 'country,date'
    case 'devices': return 'device,date'
  }
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

export const dumpCommand = defineCommand({
  meta: {
    name: 'dump',
    description: 'Export search analytics data via GSC API',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com)',
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
    start: {
      type: 'string',
      description: 'Start date (YYYY-MM-DD)',
    },
    end: {
      type: 'string',
      description: 'End date (YYYY-MM-DD)',
    },
    days: {
      type: 'string',
      alias: 'd',
      default: '28',
      description: 'Number of days to fetch (default: 28)',
    },
    types: {
      type: 'string',
      alias: 't',
      description: 'Data types: pages,keywords,countries,devices',
    },
    limit: {
      type: 'string',
      alias: 'l',
      default: '25000',
      description: 'Max rows per data type',
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
      description: 'Interactive mode - prompts for options',
    },
  },
  async run({ args }) {
    const config = await loadConfig()

    // Resolve date range (shared by cloud and local)
    let startDate: string
    let endDate: string

    if (args.start && args.end) {
      startDate = String(args.start)
      endDate = String(args.end)
    }
    else if (args.interactive) {
      const startInput = await text({
        message: 'Start date (YYYY-MM-DD)',
        placeholder: new Date(Date.now() - Number(args.days) * 86400000).toISOString().split('T')[0],
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

      startDate = String(startInput) || new Date(Date.now() - Number(args.days) * 86400000).toISOString().split('T')[0]
      endDate = String(endInput) || new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]
    }
    else {
      const days = Number.parseInt(String(args.days), 10)
      endDate = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]
      startDate = new Date(Date.now() - (days + 3) * 86400000).toISOString().split('T')[0]
    }

    // Resolve data types
    let dataTypes: DumpDataType[]

    if (args.types) {
      dataTypes = String(args.types).split(',').filter(t => DUMP_DATA_TYPES.includes(t as DumpDataType)) as DumpDataType[]
    }
    else if (args.interactive) {
      const selected = await multiselect({
        message: 'Select data types to export',
        options: DUMP_DATA_TYPES.map(t => ({ value: t, label: t })),
        initialValues: ['pages', 'keywords'],
      })
      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }
      dataTypes = selected as DumpDataType[]
    }
    else {
      dataTypes = ['pages', 'keywords']
    }

    const rowLimit = Number.parseInt(String(args.limit), 10)
    const format = String(args.format) as 'json' | 'csv'

    // Cloud mode
    const cloud = await getCloudClient()
    if (cloud) {
      const { siteId, siteUrl } = await resolveCloudSite(cloud, args.site || config.defaultSite)

      const output: Record<string, unknown> = {
        siteUrl,
        dateRange: { start: startDate, end: endDate },
        exportedAt: new Date().toISOString(),
      }

      const totalSteps = dataTypes.length
      let currentStep = 0

      for (const dataType of dataTypes) {
        currentStep++
        if (!args.quiet) {
          clearLine()
          process.stdout.write(progressBar(currentStep, totalSteps, dataType))
        }

        const dimensions = getDimensionNames(dataType)
        const result = await cloud.query(siteId, {
          startDate,
          endDate,
          dimensions,
          rowLimit: String(rowLimit),
        }).catch((e: Error) => {
          logger.error(`Query failed: ${e.message}`)
          process.exit(1)
        })

        output[dataType] = { total: result.rows.length, data: result.rows }
      }

      if (!args.quiet) {
        clearLine()
        logger.success(`Exported ${dataTypes.join(', ')} for ${siteUrl}`)
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

    const output: Record<string, unknown> = {
      siteUrl,
      dateRange: { start: startDate, end: endDate },
      exportedAt: new Date().toISOString(),
    }

    const totalSteps = dataTypes.length
    let currentStep = 0

    for (const dataType of dataTypes) {
      currentStep++
      if (!args.quiet) {
        clearLine()
        process.stdout.write(progressBar(currentStep, totalSteps, dataType))
      }

      const dimensions = getDimensions(dataType)
      const builder = gsc
        .select(...dimensions)
        .where(between(date, startDate, endDate))
        .limit(rowLimit)

      const rows: Record<string, unknown>[] = []
      for await (const batch of client.query(siteUrl, builder)) {
        rows.push(...batch)
      }

      output[dataType] = { total: rows.length, data: rows }
    }

    if (!args.quiet) {
      clearLine()
      logger.success(`Exported ${dataTypes.join(', ')} for ${siteUrl}`)
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
