import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { isCloudDriver } from 'gscdump/driver'
import { loadConfig } from '../config'
import { getDriver } from '../driver'
import { logger } from '../utils'

async function resolveCloudSiteUrl(driver: Awaited<ReturnType<typeof getDriver>>, target?: string): Promise<string> {
  if (!isCloudDriver(driver)) {
    logger.error('This command requires cloud mode. Run gscdump init to set up.')
    process.exit(1)
  }

  const sites = await driver.sitesWithSync().catch((e: Error) => {
    logger.error(`Failed to fetch sites: ${e.message}`)
    process.exit(1)
  })

  if (sites.length === 0) {
    logger.error('No registered sites. Run gscdump register first.')
    process.exit(1)
  }

  const match = target
    ? sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
    : undefined

  if (match)
    return match.siteUrl
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

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show indexing status overview (cloud mode)',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    days: { type: 'string', alias: 'd', default: '28', description: 'Days of trend data (max 90)' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('Indexing status requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const siteUrl = await resolveCloudSiteUrl(driver, args.site || config.defaultSite)

    const data = await driver.indexing(siteUrl, { days: Number(args.days) }).catch((e: Error) => {
      logger.error(`Failed to fetch indexing data: ${e.message}`)
      process.exit(1)
    })

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    const s = data.summary
    console.log()
    console.log(`  \x1B[1m${siteUrl}\x1B[0m — Indexing Status`)
    console.log()
    console.log(`  Total URLs:     \x1B[36m${s.totalUrls.toLocaleString()}\x1B[0m`)
    console.log(`  Indexed:        \x1B[32m${s.indexed.toLocaleString()}\x1B[0m (${s.indexedPercent}%)`)
    console.log(`  Not Indexed:    \x1B[31m${s.notIndexed.toLocaleString()}\x1B[0m`)
    if (s.pending > 0)
      console.log(`  Pending:        \x1B[33m${s.pending.toLocaleString()}\x1B[0m`)

    if (s.change7d !== null || s.change28d !== null) {
      console.log()
      if (s.change7d !== null) {
        const color = s.change7d > 0 ? '\x1B[32m+' : s.change7d < 0 ? '\x1B[31m' : '\x1B[90m'
        console.log(`  7d change:      ${color}${s.change7d}%\x1B[0m`)
      }
      if (s.change28d !== null) {
        const color = s.change28d > 0 ? '\x1B[32m+' : s.change28d < 0 ? '\x1B[31m' : '\x1B[90m'
        console.log(`  28d change:     ${color}${s.change28d}%\x1B[0m`)
      }
    }

    if (data.trend.length > 1) {
      console.log()
      console.log('  \x1B[1mTrend (indexed %)\x1B[0m')
      const recent = data.trend.slice(-14)
      for (const t of recent) {
        const bar = '█'.repeat(Math.round(t.indexedPercent / 5))
        console.log(`  ${t.date}  \x1B[36m${bar}\x1B[0m ${t.indexedPercent}%`)
      }
    }
    console.log()
  },
})

const diagnosticsCommand = defineCommand({
  meta: {
    name: 'diagnostics',
    description: 'Show indexing issue diagnostics (cloud mode)',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('Indexing diagnostics requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const siteUrl = await resolveCloudSiteUrl(driver, args.site || config.defaultSite)

    const data = await driver.indexingDiagnostics(siteUrl).catch((e: Error) => {
      logger.error(`Failed to fetch diagnostics: ${e.message}`)
      process.exit(1)
    })

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    console.log()
    console.log(`  \x1B[1m${siteUrl}\x1B[0m — Indexing Diagnostics`)
    console.log()
    console.log(`  Total: \x1B[36m${data.summary.totalUrls.toLocaleString()}\x1B[0m URLs, \x1B[32m${data.summary.indexed.toLocaleString()}\x1B[0m indexed (${data.summary.indexedPercent}%)`)
    console.log()

    if (data.issues.length === 0) {
      logger.success('No indexing issues found!')
      return
    }

    console.log('  \x1B[1mIssues\x1B[0m')
    for (const issue of data.issues) {
      const color = issue.severity === 'error' ? '\x1B[31m' : issue.severity === 'warning' ? '\x1B[33m' : '\x1B[90m'
      console.log(`  ${color}${issue.severity.toUpperCase().padEnd(7)}\x1B[0m ${issue.label} — \x1B[36m${issue.count.toLocaleString()}\x1B[0m URLs`)
    }
    console.log()
  },
})

const urlsCommand = defineCommand({
  meta: {
    name: 'urls',
    description: 'List URLs with indexing status (cloud mode)',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    status: { type: 'string', description: 'Filter: indexed, not_indexed, pending' },
    issue: { type: 'string', description: 'Filter by issue type' },
    search: { type: 'string', description: 'Search URLs' },
    limit: { type: 'string', alias: 'l', default: '50', description: 'Max results' },
    offset: { type: 'string', default: '0', description: 'Offset for pagination' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('Indexing URLs requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const siteUrl = await resolveCloudSiteUrl(driver, args.site || config.defaultSite)

    const data = await driver.indexingUrls(siteUrl, {
      status: args.status ? String(args.status) : undefined,
      issue: args.issue ? String(args.issue) : undefined,
      search: args.search ? String(args.search) : undefined,
      limit: Number(args.limit),
      offset: Number(args.offset),
    }).catch((e: Error) => {
      logger.error(`Failed to fetch URLs: ${e.message}`)
      process.exit(1)
    })

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    console.log()
    console.log(`  \x1B[1m${siteUrl}\x1B[0m — ${data.pagination.total.toLocaleString()} URLs (showing ${data.urls.length})`)
    console.log()

    for (const url of data.urls) {
      const verdictColor = url.verdict === 'PASS' ? '\x1B[32m' : url.verdict ? '\x1B[31m' : '\x1B[33m'
      const verdictLabel = url.verdict === 'PASS' ? 'INDEXED' : url.verdict ? 'NOT INDEXED' : 'PENDING'
      console.log(`  ${verdictColor}${verdictLabel.padEnd(12)}\x1B[0m ${url.url}`)
      if (url.coverageState && url.coverageState !== 'Submitted and indexed')
        console.log(`               \x1B[90m${url.coverageState}\x1B[0m`)
    }

    if (data.pagination.hasMore)
      console.log(`\n  \x1B[90m... ${data.pagination.total - data.pagination.offset - data.urls.length} more (use --offset ${data.pagination.offset + data.urls.length})\x1B[0m`)
    console.log()
  },
})

const inspectCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'Inspect a specific URL\'s indexing status',
  },
  args: {
    site: { type: 'string', alias: 's', required: true, description: 'Site URL (e.g., sc-domain:example.com)' },
    url: { type: 'positional', required: true, description: 'URL to inspect' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    const result = await driver.inspect(args.site, args.url).catch((e: Error) => {
      logger.error(`Inspection failed: ${e.message}`)
      process.exit(1)
    })

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log()
    console.log(`  \x1B[1mURL:\x1B[0m ${args.url}`)
    console.log()

    const verdictColor = result.verdict === 'PASS' ? '\x1B[32m' : '\x1B[31m'
    console.log(`  Verdict:        ${verdictColor}${result.verdict || 'N/A'}\x1B[0m`)
    if (result.coverageState)
      console.log(`  Coverage:       ${result.coverageState}`)
    if (result.indexingState)
      console.log(`  Indexing:       ${result.indexingState}`)
    if (result.lastCrawlTime)
      console.log(`  Last Crawl:     ${result.lastCrawlTime}`)

    // Show extra details from raw if available (local mode has richer raw data)
    const raw = result.raw as Record<string, unknown> | null
    if (raw) {
      const inspection = raw.inspectionResult as Record<string, unknown> | undefined
      const indexStatus = inspection?.indexStatusResult as Record<string, unknown> | undefined
      if (indexStatus?.robotsTxtState)
        console.log(`  Robots.txt:     ${indexStatus.robotsTxtState}`)
      if (indexStatus?.pageFetchState)
        console.log(`  Page Fetch:     ${indexStatus.pageFetchState}`)
      if (indexStatus?.googleCanonical)
        console.log(`  Google Canon:   ${indexStatus.googleCanonical}`)
      if (indexStatus?.userCanonical)
        console.log(`  User Canon:     ${indexStatus.userCanonical}`)
    }
    console.log()
  },
})

const indexPercentCommand = defineCommand({
  meta: {
    name: 'index-percent',
    description: 'Show index percent, invisible URLs, and orphan pages (cloud mode)',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('Index percent requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const siteUrl = await resolveCloudSiteUrl(driver, args.site || config.defaultSite)

    const data = await driver.indexPercent(siteUrl).catch((e: Error) => {
      logger.error(`Failed to fetch index percent: ${e.message}`)
      process.exit(1)
    })

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    const s = data.summary
    console.log()
    console.log(`  \x1B[1m${siteUrl}\x1B[0m — Index Percent`)
    console.log()
    console.log(`  Index Percent:     \x1B[36m${s.currentPercent}%\x1B[0m`)
    console.log(`  Sitemap URLs:      ${s.totalSitemapUrls.toLocaleString()}`)
    console.log(`  Visible in Search: \x1B[32m${s.visibleUrls.toLocaleString()}\x1B[0m`)

    if (s.change7d !== null) {
      const color = s.change7d > 0 ? '\x1B[32m+' : s.change7d < 0 ? '\x1B[31m' : '\x1B[90m'
      console.log(`  7d change:         ${color}${s.change7d.toFixed(1)}%\x1B[0m`)
    }
    if (s.change28d !== null) {
      const color = s.change28d > 0 ? '\x1B[32m+' : s.change28d < 0 ? '\x1B[31m' : '\x1B[90m'
      console.log(`  28d change:        ${color}${s.change28d.toFixed(1)}%\x1B[0m`)
    }

    if (data.invisibleCount > 0) {
      console.log()
      console.log(`  \x1B[1mInvisible URLs\x1B[0m (\x1B[33m${data.invisibleCount}\x1B[0m — in sitemap but no search traffic)`)
      for (const u of data.invisibleUrls.slice(0, 10)) {
        console.log(`    ${u.url}`)
      }
      if (data.invisibleCount > 10)
        console.log(`    \x1B[90m... and ${data.invisibleCount - 10} more\x1B[0m`)
    }

    if (data.orphanCount > 0) {
      console.log()
      console.log(`  \x1B[1mOrphan Pages\x1B[0m (\x1B[33m${data.orphanCount}\x1B[0m — has traffic but not in sitemap)`)
      for (const u of data.orphanPages.slice(0, 10)) {
        console.log(`    ${u.url} \x1B[90m(${u.clicks} clicks)\x1B[0m`)
      }
      if (data.orphanCount > 10)
        console.log(`    \x1B[90m... and ${data.orphanCount - 10} more\x1B[0m`)
    }

    if (data.sitemaps.length > 0) {
      console.log()
      console.log('  \x1B[1mSitemaps\x1B[0m')
      for (const sm of data.sitemaps) {
        console.log(`    ${sm.path} \x1B[90m(${sm.urlCount.toLocaleString()} URLs)\x1B[0m`)
      }
    }
    console.log()
  },
})

export const indexingCommand = defineCommand({
  meta: {
    name: 'indexing',
    description: 'Indexing status, diagnostics, and URL inspection',
  },
  subCommands: {
    'status': statusCommand,
    'diagnostics': diagnosticsCommand,
    'urls': urlsCommand,
    'inspect': inspectCommand,
    'index-percent': indexPercentCommand,
  },
})
