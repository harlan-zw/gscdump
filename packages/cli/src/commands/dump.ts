import type { DataProvider, DataSource } from '@gscdump/query'
import type { OAuth2Client } from 'google-auth-library'
import type { DataType, ResolvedAnalyticsRange } from 'gscdump'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { cancel, confirm, isCancel, multiselect, select, text } from '@clack/prompts'
import { createGscDb } from '@gscdump/db'
import { createProvider } from '@gscdump/query'
import { defineCommand } from 'citty'
import dayjs from 'dayjs'
import betterSqlite3 from 'db0/connectors/better-sqlite3'
import { fetchGscSites } from 'gscdump'
import { loadConfig } from '../config'
import { clearLine, exportToCSV, gscErrorHandler, logger, parsePeriod, progressBar } from '../utils'

const DUMP_DATA_TYPES = ['pages', 'keywords', 'countries', 'devices'] as const
type DumpDataType = typeof DUMP_DATA_TYPES[number]

async function getSites(auth: OAuth2Client): Promise<string[]> {
  const sites = await fetchGscSites(auth)
  return sites
    .filter(site => site.siteUrl && site.permissionLevel !== 'siteUnverifiedUser')
    .map(site => site.siteUrl!)
}

interface DumpOptions {
  fresh?: boolean
  searchType?: DataType
}

async function runDump(
  provider: DataProvider,
  selectedSites: string[],
  dataTypes: DumpDataType[],
  period: { amount: number, unit: 'days' | 'months' | 'years' },
  format: 'json' | 'csv',
  outputFile: string | null,
  options: DumpOptions = {},
): Promise<void> {
  // Fresh mode: include last 3 days of unfinalized data
  const daysOffset = options.fresh ? 1 : 3
  const endDate = dayjs().subtract(daysOffset, 'days').format('YYYY-MM-DD')
  const startDate = dayjs().subtract(period.amount, period.unit).subtract(daysOffset, 'days').format('YYYY-MM-DD')

  const range: ResolvedAnalyticsRange = {
    period: { start: startDate, end: endDate },
    prevPeriod: {
      start: dayjs(startDate).subtract(period.amount, period.unit).format('YYYY-MM-DD'),
      end: dayjs(endDate).subtract(period.amount, period.unit).format('YYYY-MM-DD'),
    },
  }

  for (const siteUrl of selectedSites) {
    const siteName = siteUrl.replace(/https?:\/\//, '').replace(/\/$/, '')

    const output: Record<string, unknown> = {
      siteUrl,
      source: provider.source,
      dateRange: { startDate, endDate },
      period: { amount: period.amount, unit: period.unit },
      dataTypes,
      fresh: options.fresh || false,
      searchType: options.searchType || 'web',
    }

    const totalSteps = dataTypes.length
    let currentStep = 0

    for (const dataType of dataTypes) {
      currentStep++
      clearLine()
      process.stdout.write(progressBar(currentStep, totalSteps, `${dataType} (${siteName})`))

      if (dataType === 'pages') {
        const pages = await provider.getPages(siteUrl, range)
        output.pages = { total: pages.length, data: pages }
      }
      else if (dataType === 'keywords') {
        const keywordsData = await provider.getKeywordsWithComparison(siteUrl, range)
        output.keywords = {
          total: keywordsData.current.length,
          current: keywordsData.current,
          previous: keywordsData.previous,
          metadata: keywordsData.metadata,
        }
      }
      else if (dataType === 'countries') {
        const countriesData = await provider.getCountriesWithComparison(siteUrl, range)
        output.countries = {
          current: countriesData.current,
          previous: countriesData.previous,
          metadata: countriesData.metadata,
        }
      }
      else if (dataType === 'devices') {
        const devicesData = await provider.getDevicesWithComparison(siteUrl, range)
        output.devices = {
          current: devicesData.current,
          previous: devicesData.previous,
          metadata: devicesData.metadata,
        }
      }
    }

    clearLine()

    const ext = format === 'csv' ? 'csv' : 'json'
    const filename = outputFile || `gsc-${siteName.replace(/\//g, '_')}-${dataTypes.join('-')}-${period.amount}${period.unit[0]}-${endDate}.${ext}`

    const content = format === 'csv' ? exportToCSV(output) : JSON.stringify(output, null, 2)
    await fs.writeFile(filename, content)

    const totalItems = ((output.pages as { total: number } | undefined)?.total || 0)
      + ((output.keywords as { total: number } | undefined)?.total || 0)
      + ((output.countries as { current: unknown[] } | undefined)?.current?.length || 0)
      + ((output.devices as { current: unknown[] } | undefined)?.current?.length || 0)

    logger.success(`Saved ${totalItems} items to ${filename} (source: ${provider.source})`)
  }
}

async function interactiveMode(auth: OAuth2Client, dbPath: string | null, source: DataSource): Promise<void> {
  process.stdout.write('  Fetching sites...')
  const sites = await getSites(auth)
  clearLine()
  logger.success(`Found ${sites.length} sites`)

  if (sites.length === 0) {
    cancel('No sites found in your Google Search Console account.')
    return
  }

  const selectedSites = await multiselect({
    message: 'Select sites to dump data from:',
    options: sites.map(site => ({ value: site, label: site })),
  })

  if (isCancel(selectedSites) || selectedSites.length === 0) {
    cancel('Operation cancelled.')
    return
  }

  const dataTypes = await multiselect({
    message: 'What data would you like to dump?',
    options: [
      { value: 'pages', label: 'Pages (URLs and performance data)', hint: 'recommended' },
      { value: 'keywords', label: 'Keywords (search queries and rankings)' },
      { value: 'countries', label: 'Countries (geographic performance)' },
      { value: 'devices', label: 'Devices (desktop, mobile, tablet)' },
    ],
    required: true,
  }) as DumpDataType[]

  if (isCancel(dataTypes) || dataTypes.length === 0) {
    cancel('Operation cancelled.')
    return
  }

  const periodInput = await text({
    message: 'Time period (e.g., 90d, 6m, 1y):',
    placeholder: '180d',
    defaultValue: '180d',
    validate: (value) => {
      if (!value)
        return undefined
      return parsePeriod(value) ? undefined : 'Invalid format. Use: 90d, 6m, 1y'
    },
  })

  if (isCancel(periodInput)) {
    cancel('Operation cancelled.')
    return
  }

  const formatResult = await multiselect({
    message: 'Output format:',
    options: [
      { value: 'json', label: 'JSON', hint: 'structured data' },
      { value: 'csv', label: 'CSV', hint: 'spreadsheet compatible' },
    ],
    required: true,
  })

  if (isCancel(formatResult)) {
    cancel('Operation cancelled.')
    return
  }

  // Ask about data source if db path exists
  let finalSource = source
  if (dbPath && source === 'auto') {
    const sourceResult = await select({
      message: 'Data source:',
      options: [
        { value: 'auto', label: 'Auto', hint: 'use DB if data exists, else API' },
        { value: 'api', label: 'API', hint: 'always fetch from Google' },
        { value: 'db', label: 'Database', hint: 'use synced data' },
      ],
    })
    if (isCancel(sourceResult)) {
      cancel('Operation cancelled.')
      return
    }
    finalSource = sourceResult as DataSource
  }

  const format = (formatResult as string[])[0] as 'json' | 'csv'
  const period = parsePeriod(periodInput || '180d')!

  const ready = await confirm({
    message: `Dump ${dataTypes.join(', ')} for ${selectedSites.length} site(s), ${period.amount}${period.unit[0]}, as ${format.toUpperCase()}?`,
  })

  if (isCancel(ready) || !ready) {
    cancel('Operation cancelled.')
    return
  }

  console.log()

  // Build range for provider selection
  const endDate = dayjs().subtract(3, 'days').format('YYYY-MM-DD')
  const startDate = dayjs().subtract(period.amount, period.unit).subtract(3, 'days').format('YYYY-MM-DD')
  const range: ResolvedAnalyticsRange = {
    period: { start: startDate, end: endDate },
    prevPeriod: {
      start: dayjs(startDate).subtract(period.amount, period.unit).format('YYYY-MM-DD'),
      end: dayjs(endDate).subtract(period.amount, period.unit).format('YYYY-MM-DD'),
    },
  }

  // Create provider
  let db = null
  if (dbPath) {
    const dbExists = await fs.access(dbPath).then(() => true).catch(() => false)
    if (dbExists)
      db = createGscDb(betterSqlite3({ name: path.resolve(dbPath) })).db
  }

  const provider = await createProvider({
    auth,
    db,
    source: finalSource,
    siteUrls: selectedSites,
    range,
  })

  logger.info(`Using ${provider.source.toUpperCase()} as data source`)
  await runDump(provider, selectedSites, dataTypes, period, format, null)
}

async function nonInteractiveMode(
  auth: OAuth2Client,
  site: string[],
  data: string[],
  periodStr: string,
  format: 'json' | 'csv',
  output: string | null,
  dbPath: string | null,
  source: DataSource,
  options: DumpOptions = {},
): Promise<void> {
  if (site.length === 0) {
    logger.error('--site required in non-interactive mode')
    process.exit(1)
  }

  if (data.length === 0) {
    logger.error('--data required in non-interactive mode')
    process.exit(1)
  }

  const invalidData = data.filter(d => !DUMP_DATA_TYPES.includes(d as DumpDataType))
  if (invalidData.length > 0) {
    logger.error(`Invalid data types: ${invalidData.join(', ')}`)
    logger.info('Valid types: pages, keywords, countries, devices')
    process.exit(1)
  }

  const period = parsePeriod(periodStr)
  if (!period) {
    logger.error(`Invalid period: ${periodStr}`)
    logger.info('Examples: 90d, 6m, 1y')
    process.exit(1)
  }

  process.stdout.write('  Validating sites...')
  const availableSites = await getSites(auth)
  clearLine()

  const normalizedSites: string[] = []
  for (const s of site) {
    const match = availableSites.find(avail =>
      avail === s
      || avail === `https://${s}`
      || avail === `http://${s}`
      || avail === `sc-domain:${s}`
      || avail.replace(/https?:\/\//, '').replace(/\/$/, '') === s.replace(/\/$/, ''),
    )
    if (!match) {
      logger.error(`Site not found: ${s}`)
      logger.info('Available sites:')
      availableSites.slice(0, 5).forEach(a => console.log(`    - ${a}`))
      if (availableSites.length > 5)
        console.log(`    ... and ${availableSites.length - 5} more`)
      process.exit(1)
    }
    normalizedSites.push(match)
  }

  // Build range for provider selection
  const daysOffset = options.fresh ? 1 : 3
  const endDate = dayjs().subtract(daysOffset, 'days').format('YYYY-MM-DD')
  const startDate = dayjs().subtract(period.amount, period.unit).subtract(daysOffset, 'days').format('YYYY-MM-DD')
  const range: ResolvedAnalyticsRange = {
    period: { start: startDate, end: endDate },
    prevPeriod: {
      start: dayjs(startDate).subtract(period.amount, period.unit).format('YYYY-MM-DD'),
      end: dayjs(endDate).subtract(period.amount, period.unit).format('YYYY-MM-DD'),
    },
  }

  // Create provider
  let db = null
  if (dbPath) {
    const dbExists = await fs.access(dbPath).then(() => true).catch(() => false)
    if (dbExists) {
      db = createGscDb(betterSqlite3({ name: path.resolve(dbPath) })).db
    }
    else if (source === 'db') {
      logger.error(`Database not found: ${dbPath}`)
      logger.info('Run \'gscdump sync\' first to create the database.')
      process.exit(1)
    }
  }

  const provider = await createProvider({
    auth,
    db,
    source,
    siteUrls: normalizedSites,
    range,
  }).catch(gscErrorHandler)

  const extras: string[] = []
  if (options.fresh)
    extras.push('fresh')
  if (options.searchType && options.searchType !== 'web')
    extras.push(options.searchType)
  const extrasStr = extras.length ? ` [${extras.join(', ')}]` : ''

  logger.info(`${normalizedSites.length} site(s), ${data.join('+')} data, ${period.amount}${period.unit[0]}, ${format}, source: ${provider.source}${extrasStr}`)
  console.log()

  await runDump(provider, normalizedSites, data as DumpDataType[], period, format, output, options)
}

export const dumpCommand = defineCommand({
  meta: {
    name: 'dump',
    description: 'Export GSC data to JSON or CSV files',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (comma-separated for multiple)',
    },
    data: {
      type: 'string',
      alias: 'd',
      description: 'Data types: pages,keywords,countries,devices',
    },
    period: {
      type: 'string',
      alias: 'p',
      default: '180d',
      description: 'Time period: 90d, 6m, 1y',
    },
    format: {
      type: 'string',
      alias: 'f',
      default: 'json',
      description: 'Output format: json, csv',
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output filename',
    },
    source: {
      type: 'string',
      default: 'auto',
      description: 'Data source: auto, api, db',
    },
    db: {
      type: 'string',
      description: 'SQLite database path (for db/auto source)',
    },
    fresh: {
      type: 'boolean',
      default: false,
      description: 'Include fresh/unfinalized data (last 3 days)',
    },
    type: {
      type: 'string',
      alias: 't',
      default: 'web',
      description: 'Search type: web, image, video, news, discover, googleNews',
    },
  },
  async run({ args }) {
    const config = await loadConfig()

    // Apply config defaults
    const siteArg = args.site || config.defaultSite
    const sites = siteArg ? siteArg.split(',') : []
    const data = args.data ? args.data.split(',') : []
    const periodArg = args.period === '180d' && config.defaultPeriod ? config.defaultPeriod : args.period
    const formatArg = args.format === 'json' && config.defaultFormat ? config.defaultFormat : args.format
    const dbPath = args.db || config.defaultDb || null
    const source = (['auto', 'api', 'db'].includes(args.source) ? args.source : 'auto') as DataSource

    const isInteractive = sites.length === 0 && data.length === 0

    const { getAuth } = await import('../auth')
    const auth = await getAuth({ interactive: isInteractive, config })

    const searchTypes = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const
    const searchType = searchTypes.includes(args.type as typeof searchTypes[number])
      ? args.type as DataType
      : 'web'
    const options: DumpOptions = { fresh: args.fresh, searchType }

    if (isInteractive) {
      await interactiveMode(auth, dbPath, source)
    }
    else {
      const format = formatArg === 'csv' ? 'csv' : 'json'
      await nonInteractiveMode(auth, sites, data, periodArg, format, args.output || null, dbPath, source, options)
    }

    logger.success('Done!')
  },
})
