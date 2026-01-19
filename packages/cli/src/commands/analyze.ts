import type { GscDb } from '@gscdump/db'
import type { DataProvider } from '@gscdump/query'
import type { Auth, ResolvedAnalyticsRange } from 'gscdump'
import path from 'node:path'
import process from 'node:process'
import { createGscDb } from '@gscdump/db'
import {
  createProvider,
  fetchCannibalizationAnalysis,
  fetchDecayAnalysis,
  fetchMoversAnalysis,
  fetchOpportunityAnalysis,
  fetchStrikingDistanceAnalysis,
  fetchZeroClickAnalysis,
} from '@gscdump/query'
import { defineCommand } from 'citty'
import dayjs from 'dayjs'
import betterSqlite3 from 'db0/connectors/better-sqlite3'
import { getAuth } from '../auth'
import { loadConfig } from '../config'
import { gscErrorHandler, logger, parsePeriod } from '../utils'

type DataSource = 'api' | 'db' | 'auto'

function getProviderForSource(auth: Auth, db: GscDb | null, source: DataSource): DataProvider {
  if (source === 'api')
    return createProvider({ auth })
  if (source === 'db') {
    if (!db)
      throw new Error('Database required for db source')
    return createProvider({ db })
  }
  return db ? createProvider({ auth, db }) : createProvider({ auth })
}

const ANALYSIS_TYPES = [
  'striking-distance',
  'opportunity',
  'movers',
  'decay',
  'cannibalization',
  'zero-click',
] as const

type AnalysisType = typeof ANALYSIS_TYPES[number]

export const analyzeCommand = defineCommand({
  meta: {
    name: 'analyze',
    description: 'Run SEO analysis on site data',
  },
  args: {
    type: {
      type: 'positional',
      required: true,
      description: `Analysis type: ${ANALYSIS_TYPES.join(', ')}`,
    },
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com)',
    },
    period: {
      type: 'string',
      alias: 'p',
      default: '28d',
      description: 'Period to analyze (e.g., 7d, 28d, 3m)',
    },
    limit: {
      type: 'string',
      alias: 'l',
      default: '20',
      description: 'Number of results to show',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Output as JSON',
    },
    db: {
      type: 'string',
      alias: 'd',
      description: 'Path to SQLite database',
    },
    source: {
      type: 'string',
      default: 'auto',
      description: 'Data source: api, db, auto',
    },
    // Analysis-specific options
    minPosition: {
      type: 'string',
      description: 'Minimum position (striking-distance)',
    },
    maxPosition: {
      type: 'string',
      description: 'Maximum position (striking-distance, zero-click)',
    },
    minImpressions: {
      type: 'string',
      description: 'Minimum impressions',
    },
    minClicks: {
      type: 'string',
      description: 'Minimum clicks (decay)',
    },
    threshold: {
      type: 'string',
      description: 'Threshold percentage 0-1 (decay, movers)',
    },
  },
  async run({ args }) {
    const analysisType = args.type as AnalysisType
    if (!ANALYSIS_TYPES.includes(analysisType)) {
      logger.error(`Unknown analysis type: ${analysisType}`)
      logger.info(`Available: ${ANALYSIS_TYPES.join(', ')}`)
      process.exit(1)
    }

    const config = await loadConfig()
    const siteArg = args.site || config.defaultSite
    if (!siteArg) {
      logger.error('Site required. Use --site or set defaultSite in config.')
      process.exit(1)
    }

    const dbPath = args.db || config.defaultDb
    const auth = await getAuth({ interactive: false, config })

    // Build date range
    const period = parsePeriod(args.period)
    if (!period) {
      logger.error(`Invalid period: ${args.period}`)
      process.exit(1)
    }

    const endDate = dayjs().subtract(3, 'day')
    const startDate = endDate.subtract(period.amount, period.unit)
    const prevEndDate = startDate.subtract(1, 'day')
    const prevStartDate = prevEndDate.subtract(period.amount, period.unit)

    const range: ResolvedAnalyticsRange = {
      period: { start: startDate.format('YYYY-MM-DD'), end: endDate.format('YYYY-MM-DD') },
      prevPeriod: { start: prevStartDate.format('YYYY-MM-DD'), end: prevEndDate.format('YYYY-MM-DD') },
    }

    // Setup DB if provided
    const db = dbPath
      ? createGscDb(betterSqlite3({ name: path.resolve(dbPath) })).db
      : null

    const provider = getProviderForSource(auth, db, args.source as DataSource)

    const limit = Number.parseInt(args.limit, 10) || 20

    if (!args.json) {
      console.log()
      console.log(`  \x1B[1m${siteArg}\x1B[0m`)
      console.log(`  \x1B[90mSource:   ${provider.source}\x1B[0m`)
      console.log(`  \x1B[90mPeriod:   ${range.period.start} → ${range.period.end}\x1B[0m`)
      console.log(`  \x1B[90mAnalysis: ${analysisType}\x1B[0m`)
      console.log()
    }

    let results: unknown

    switch (analysisType) {
      case 'striking-distance':
        results = await fetchStrikingDistanceAnalysis(provider, siteArg, range, {
          minPosition: args.minPosition ? Number(args.minPosition) : undefined,
          maxPosition: args.maxPosition ? Number(args.maxPosition) : undefined,
          minImpressions: args.minImpressions ? Number(args.minImpressions) : undefined,
        }).catch(gscErrorHandler)
        break

      case 'opportunity':
        results = await fetchOpportunityAnalysis(provider, siteArg, range, {
          minImpressions: args.minImpressions ? Number(args.minImpressions) : undefined,
        }).catch(gscErrorHandler)
        break

      case 'movers':
        results = await fetchMoversAnalysis(provider, siteArg, range, {
          changeThreshold: args.threshold ? Number(args.threshold) : undefined,
          minImpressions: args.minImpressions ? Number(args.minImpressions) : undefined,
        }).catch(gscErrorHandler)
        break

      case 'decay':
        results = await fetchDecayAnalysis(provider, siteArg, range, {
          minPreviousClicks: args.minClicks ? Number(args.minClicks) : undefined,
          threshold: args.threshold ? Number(args.threshold) : undefined,
        }).catch(gscErrorHandler)
        break

      case 'cannibalization':
        results = await fetchCannibalizationAnalysis(provider, siteArg, range, {
          minImpressions: args.minImpressions ? Number(args.minImpressions) : undefined,
        }).catch(gscErrorHandler)
        break

      case 'zero-click':
        results = await fetchZeroClickAnalysis(provider, siteArg, range, {
          minImpressions: args.minImpressions ? Number(args.minImpressions) : undefined,
          maxPosition: args.maxPosition ? Number(args.maxPosition) : undefined,
        }).catch(gscErrorHandler)
        break
    }

    if (args.json) {
      console.log(JSON.stringify({ site: siteArg, source: provider.source, analysis: analysisType, range, results }, null, 2))
      return
    }

    // Format results based on type
    const arr = Array.isArray(results) ? results : []
    const display = arr.slice(0, limit)

    if (display.length === 0) {
      logger.warn('No results found')
      return
    }

    console.log(`  \x1B[1mResults\x1B[0m \x1B[90m(${arr.length} total, showing ${display.length})\x1B[0m`)

    for (const item of display) {
      formatResultItem(analysisType, item)
    }

    console.log()
    logger.success('Analysis complete')
  },
})

function formatResultItem(type: AnalysisType, item: Record<string, unknown>) {
  const keyword = (item.keyword || item.query || '') as string
  const page = (item.page || '') as string

  switch (type) {
    case 'striking-distance':
      console.log(`    ${keyword.slice(0, 40).padEnd(40)} pos ${String(item.position || 0).padStart(5)} ${formatNumber(item.impressions as number)} impr ${formatNumber(item.potentialClicks as number)} potential`)
      break
    case 'opportunity':
      console.log(`    ${keyword.slice(0, 40).padEnd(40)} score ${String((item.score as number || 0).toFixed(1)).padStart(6)} ${formatNumber(item.impressions as number)} impr`)
      break
    case 'movers':
      console.log(`    ${keyword.slice(0, 40).padEnd(40)} ${formatChange(item.clicksChange as number)} clicks ${formatChange(item.positionChange as number)} pos`)
      break
    case 'decay':
      console.log(`    ${page.replace(/^https?:\/\/[^/]+/, '').slice(0, 50).padEnd(50)} -${formatNumber(item.lostClicks as number)} clicks (${((item.declinePercent as number || 0) * 100).toFixed(0)}% decline)`)
      break
    case 'cannibalization':
      console.log(`    ${keyword.slice(0, 40).padEnd(40)} ${item.pageCount} pages ${formatNumber(item.clicks as number)} clicks spread ${item.positionSpread}`)
      break
    case 'zero-click':
      console.log(`    ${keyword.slice(0, 40).padEnd(40)} pos ${String(item.position || 0).padStart(5)} ${formatNumber(item.impressions as number)} impr ${((item.ctr as number || 0) * 100).toFixed(2)}% ctr`)
      break
  }
}

function formatNumber(val: number | null | undefined): string {
  if (val === undefined || val === null)
    return '-'
  return val.toLocaleString()
}

function formatChange(val: number | null | undefined): string {
  if (val === undefined || val === null || !Number.isFinite(val))
    return '\x1B[90m-\x1B[0m'
  const sign = val > 0 ? '+' : ''
  const color = val > 0 ? '\x1B[32m' : val < 0 ? '\x1B[31m' : '\x1B[90m'
  return `${color}${sign}${val.toFixed(1)}%\x1B[0m`
}
