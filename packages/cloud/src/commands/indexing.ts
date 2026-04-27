import { defineCommand } from 'citty'
import { deltaColor, GREEN, RED, severityColor, YELLOW } from '../ansi'
import { getDriver } from '../session'
import { exitOnError, loadSites, logger, resolveSiteUrl } from '../utils'

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show indexing status overview',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    days: { type: 'string', alias: 'd', default: '28', description: 'Days of trend data (max 90)' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver()
    const sites = await loadSites(driver)
    const siteUrl = await resolveSiteUrl(sites, args.site)

    const data = await exitOnError(driver.indexing(siteUrl, { days: Number(args.days) }), 'Failed to fetch indexing data')

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
        const sign = s.change7d > 0 ? '+' : ''
        console.log(`  7d change:      ${deltaColor(s.change7d)}${sign}${s.change7d}%\x1B[0m`)
      }
      if (s.change28d !== null) {
        const sign = s.change28d > 0 ? '+' : ''
        console.log(`  28d change:     ${deltaColor(s.change28d)}${sign}${s.change28d}%\x1B[0m`)
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
    description: 'Show indexing issue diagnostics',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver()
    const sites = await loadSites(driver)
    const siteUrl = await resolveSiteUrl(sites, args.site)

    const data = await exitOnError(driver.indexingDiagnostics(siteUrl), 'Failed to fetch diagnostics')

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
      const color = severityColor(issue.severity)
      console.log(`  ${color}${issue.severity.toUpperCase().padEnd(7)}\x1B[0m ${issue.label} — \x1B[36m${issue.count.toLocaleString()}\x1B[0m URLs`)
    }
    console.log()
  },
})

const urlsCommand = defineCommand({
  meta: {
    name: 'urls',
    description: 'List URLs with indexing status',
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
    const driver = await getDriver()
    const sites = await loadSites(driver)
    const siteUrl = await resolveSiteUrl(sites, args.site)

    const data = await exitOnError(driver.indexingUrls(siteUrl, {
      status: args.status ? String(args.status) : undefined,
      issue: args.issue ? String(args.issue) : undefined,
      search: args.search ? String(args.search) : undefined,
      limit: Number(args.limit),
      offset: Number(args.offset),
    }), 'Failed to fetch URLs')

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    console.log()
    console.log(`  \x1B[1m${siteUrl}\x1B[0m — ${data.pagination.total.toLocaleString()} URLs (showing ${data.urls.length})`)
    console.log()

    for (const url of data.urls) {
      const verdictColor = url.verdict === 'PASS' ? GREEN : url.verdict ? RED : YELLOW
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

const indexPercentCommand = defineCommand({
  meta: {
    name: 'index-percent',
    description: 'Show index percent, invisible URLs, and orphan pages',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver()
    const sites = await loadSites(driver)
    const siteUrl = await resolveSiteUrl(sites, args.site)

    const data = await exitOnError(driver.indexPercent(siteUrl), 'Failed to fetch index percent')

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
      const sign = s.change7d > 0 ? '+' : ''
      console.log(`  7d change:         ${deltaColor(s.change7d)}${sign}${s.change7d.toFixed(1)}%\x1B[0m`)
    }
    if (s.change28d !== null) {
      const sign = s.change28d > 0 ? '+' : ''
      console.log(`  28d change:        ${deltaColor(s.change28d)}${sign}${s.change28d.toFixed(1)}%\x1B[0m`)
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
    description: 'Cloud indexing status, diagnostics, and URL analysis',
  },
  subCommands: {
    'status': statusCommand,
    'diagnostics': diagnosticsCommand,
    'urls': urlsCommand,
    'index-percent': indexPercentCommand,
  },
})
