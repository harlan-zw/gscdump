import type { DataSource } from '@gscdump/query'
import type { DataType, ResolvedAnalyticsRange } from 'gscdump'
import path from 'node:path'
import process from 'node:process'
import { createGscDb } from '@gscdump/db'
import { createProvider } from '@gscdump/query'
import { defineCommand } from 'citty'
import dayjs from 'dayjs'
import betterSqlite3 from 'db0/connectors/better-sqlite3'
import { getAuth } from '../auth'
import { loadConfig } from '../config'
import { gscErrorHandler, logger, parsePeriod } from '../utils'

const SEARCH_TYPES: DataType[] = ['web', 'image', 'video', 'news', 'discover', 'googleNews']

function formatPercent(val: number | null | undefined): string {
  if (val === undefined || val === null || !Number.isFinite(val))
    return '\x1B[90m-\x1B[0m'
  const sign = val > 0 ? '+' : ''
  const color = val > 0 ? '\x1B[32m' : val < 0 ? '\x1B[31m' : '\x1B[90m'
  return `${color}${sign}${val.toFixed(1)}%\x1B[0m`
}

function formatNumber(val: number | null | undefined): string {
  if (val === undefined || val === null)
    return '-'
  return val.toLocaleString()
}

export const compareCommand = defineCommand({
  meta: {
    name: 'compare',
    description: 'Compare site performance across periods',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com)',
    },
    period: {
      type: 'string',
      alias: 'p',
      default: '7d',
      description: 'Period to compare (e.g., 7d, 30d, 3m)',
    },
    from: {
      type: 'string',
      description: 'Custom start date (YYYY-MM-DD)',
    },
    to: {
      type: 'string',
      description: 'Custom end date (YYYY-MM-DD)',
    },
    vs: {
      type: 'string',
      description: 'Comparison period start date (YYYY-MM-DD)',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Output as JSON',
    },
    type: {
      type: 'string',
      alias: 't',
      default: 'summary',
      description: 'Output type: summary, pages, keywords',
    },
    limit: {
      type: 'string',
      alias: 'l',
      default: '10',
      description: 'Number of items to show (for pages/keywords)',
    },
    fresh: {
      type: 'boolean',
      default: false,
      description: 'Include fresh/unfinalized data (last 3 days)',
    },
    searchType: {
      type: 'string',
      default: 'web',
      description: 'Search type: web, image, video, news, discover, googleNews',
    },
    db: {
      type: 'string',
      alias: 'd',
      description: 'Path to SQLite database for local queries',
    },
    source: {
      type: 'string',
      default: 'auto',
      description: 'Data source: api, db, auto',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress output',
    },
  },
  async run({ args }) {
    const config = await loadConfig()

    // Apply config defaults
    const siteArg = args.site || config.defaultSite
    if (!siteArg) {
      logger.error('Site required. Use --site or set defaultSite in config.')
      process.exit(1)
    }

    const dbPath = args.db || config.defaultDb
    const periodArg = args.period === '7d' && config.defaultPeriod ? config.defaultPeriod : args.period

    const auth = await getAuth({ interactive: false, config })

    // Build date range
    let range: ResolvedAnalyticsRange

    if (args.from && args.to) {
      const start = dayjs(args.from)
      const end = dayjs(args.to)

      if (!start.isValid() || !end.isValid()) {
        logger.error('Invalid date format. Use YYYY-MM-DD')
        process.exit(1)
      }

      const periodDays = end.diff(start, 'day')

      // Comparison period
      let prevStart: dayjs.Dayjs
      let prevEnd: dayjs.Dayjs

      if (args.vs) {
        prevStart = dayjs(args.vs)
        if (!prevStart.isValid()) {
          logger.error('Invalid --vs date format. Use YYYY-MM-DD')
          process.exit(1)
        }
        prevEnd = prevStart.add(periodDays, 'day')
      }
      else {
        prevEnd = start.subtract(1, 'day')
        prevStart = prevEnd.subtract(periodDays, 'day')
      }

      range = {
        period: { start: start.format('YYYY-MM-DD'), end: end.format('YYYY-MM-DD') },
        prevPeriod: { start: prevStart.format('YYYY-MM-DD'), end: prevEnd.format('YYYY-MM-DD') },
      }
    }
    else {
      const period = parsePeriod(periodArg)

      if (!period) {
        logger.error(`Invalid period: ${periodArg}`)
        process.exit(1)
      }

      // By default, exclude fresh/unfinalized data (last 3 days)
      // With --fresh, include up to yesterday
      const daysOffset = args.fresh ? 1 : 3
      const endDate = dayjs().subtract(daysOffset, 'day')
      const startDate = endDate.subtract(period.amount, period.unit)
      const prevEndDate = startDate.subtract(1, 'day')
      const prevStartDate = prevEndDate.subtract(period.amount, period.unit)

      range = {
        period: { start: startDate.format('YYYY-MM-DD'), end: endDate.format('YYYY-MM-DD') },
        prevPeriod: { start: prevStartDate.format('YYYY-MM-DD'), end: prevEndDate.format('YYYY-MM-DD') },
      }
    }

    // Parse search type
    const searchType = SEARCH_TYPES.includes(args.searchType as DataType)
      ? args.searchType as DataType
      : 'web'

    // Non-web search types require API (provider doesn't support queryOptions yet)
    const effectiveSource: DataSource = searchType !== 'web' ? 'api' : (args.source as DataSource || 'auto')

    if (searchType !== 'web' && args.source === 'db') {
      logger.warn(`Search type '${searchType}' requires API. Ignoring --source db.`)
    }

    // Setup DB if provided
    const db = dbPath
      ? createGscDb(betterSqlite3({ name: path.resolve(dbPath) })).db
      : null

    const provider = await createProvider({
      auth,
      db,
      source: effectiveSource,
      siteUrls: [siteArg],
      range,
    })

    if (args.json) {
      const [dates, pages, keywords] = await Promise.all([
        provider.getDatesWithComparison(siteArg, range),
        provider.getPagesWithComparison(siteArg, range),
        provider.getKeywordsWithComparison(siteArg, range),
      ]).catch(gscErrorHandler)

      console.log(JSON.stringify({
        site: siteArg,
        source: provider.source,
        range,
        dates,
        pages,
        keywords,
      }, null, 2))
      return
    }

    if (args.quiet)
      return

    console.log()
    console.log(`  \x1B[1m${siteArg}\x1B[0m`)
    console.log(`  \x1B[90mSource:   ${provider.source}\x1B[0m`)
    console.log(`  \x1B[90mCurrent:  ${range.period.start} → ${range.period.end}\x1B[0m`)
    console.log(`  \x1B[90mPrevious: ${range.prevPeriod?.start} → ${range.prevPeriod?.end}\x1B[0m`)
    console.log()

    if (args.type === 'summary' || args.type === 'all') {
      const dates = await provider.getDatesWithComparison(siteArg, range).catch(gscErrorHandler)

      console.log('  \x1B[1mSummary\x1B[0m')
      console.log(`  ┌─────────────┬──────────────┬──────────────┬─────────────┐`)
      console.log(`  │             │ \x1B[1mCurrent\x1B[0m      │ \x1B[1mPrevious\x1B[0m     │ \x1B[1mChange\x1B[0m      │`)
      console.log(`  ├─────────────┼──────────────┼──────────────┼─────────────┤`)
      console.log(`  │ Clicks      │ ${formatNumber(dates.metadata.totals.current.clicks).padStart(12)} │ ${formatNumber(dates.metadata.totals.previous.clicks).padStart(12)} │ ${formatPercent(dates.metadata.totals.clicksPercent).padStart(19)} │`)
      console.log(`  │ Impressions │ ${formatNumber(dates.metadata.totals.current.impressions).padStart(12)} │ ${formatNumber(dates.metadata.totals.previous.impressions).padStart(12)} │ ${formatPercent(dates.metadata.totals.impressionsPercent).padStart(19)} │`)
      console.log(`  │ CTR         │ ${(dates.metadata.totals.current.ctr * 100).toFixed(2).padStart(10)}% │ ${(dates.metadata.totals.previous.ctr * 100).toFixed(2).padStart(10)}% │ ${formatPercent(dates.metadata.totals.ctrPercent).padStart(19)} │`)
      console.log(`  │ Position    │ ${dates.metadata.totals.current.position.toFixed(1).padStart(12)} │ ${dates.metadata.totals.previous.position.toFixed(1).padStart(12)} │ ${formatPercent(dates.metadata.totals.positionPercent).padStart(19)} │`)
      console.log(`  └─────────────┴──────────────┴──────────────┴─────────────┘`)
      console.log()
    }

    const limit = Number.parseInt(args.limit, 10) || 10

    if (args.type === 'pages' || args.type === 'all') {
      const pages = await provider.getPagesWithComparison(siteArg, range).catch(gscErrorHandler)
      const topPages = pages.current.slice(0, limit)
      const lostPages = pages.previous.filter(p => p.lost).slice(0, 5)

      console.log(`  \x1B[1mTop Pages\x1B[0m \x1B[90m(${pages.current.length} total)\x1B[0m`)
      for (const p of topPages) {
        const pagePath = p.page.replace(/^https?:\/\/[^/]+/, '') || '/'
        console.log(`    ${pagePath.slice(0, 50).padEnd(50)} ${formatNumber(p.clicks).padStart(8)} clicks ${formatPercent(p.clicksPercent)}`)
      }

      if (lostPages.length > 0) {
        console.log()
        console.log(`  \x1B[1mLost Pages\x1B[0m \x1B[90m(had traffic in previous period)\x1B[0m`)
        for (const p of lostPages) {
          const pagePath = p.page.replace(/^https?:\/\/[^/]+/, '') || '/'
          console.log(`    \x1B[31m${pagePath.slice(0, 50).padEnd(50)}\x1B[0m ${formatNumber(p.prevClicks).padStart(8)} prev clicks`)
        }
      }
      console.log()
    }

    if (args.type === 'keywords' || args.type === 'all') {
      const keywords = await provider.getKeywordsWithComparison(siteArg, range).catch(gscErrorHandler)
      const topKeywords = keywords.current.slice(0, limit)
      const lostKeywords = keywords.previous.filter(k => k.lost).slice(0, 5)

      console.log(`  \x1B[1mTop Keywords\x1B[0m \x1B[90m(${keywords.current.length} total)\x1B[0m`)
      for (const k of topKeywords) {
        const posChange = k.prevPosition ? formatPercent(-((k.position || 0) - k.prevPosition) / k.prevPosition * 100) : ''
        console.log(`    ${k.keyword.slice(0, 40).padEnd(40)} pos ${(k.position || 0).toFixed(1).padStart(5)} ${posChange} ${formatNumber(k.clicks).padStart(6)} clicks`)
      }

      if (lostKeywords.length > 0) {
        console.log()
        console.log(`  \x1B[1mLost Keywords\x1B[0m \x1B[90m(had traffic in previous period)\x1B[0m`)
        for (const k of lostKeywords) {
          console.log(`    \x1B[31m${k.keyword.slice(0, 40).padEnd(40)}\x1B[0m pos ${(k.prevPosition || 0).toFixed(1).padStart(5)} ${formatNumber(k.prevClicks).padStart(6)} prev clicks`)
        }
      }
      console.log()
    }

    logger.success('Comparison complete')
  },
})
