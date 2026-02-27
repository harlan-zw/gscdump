import type { CloudClient, CloudMeSite } from '../cloud'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { googleSearchConsole, inspectUrl as gscInspectUrl } from 'gscdump'
import { getAuth, getCloudClient } from '../auth'
import { loadConfig } from '../config'
import { logger } from '../utils'

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
    const cloud = await getCloudClient()
    if (!cloud) {
      logger.error('Indexing status requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const { siteId, siteUrl } = await resolveCloudSite(cloud, args.site || config.defaultSite)

    const data = await cloud.indexing(siteId, { days: String(args.days) }).catch((e: Error) => {
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

    // Changes
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

    // Trend sparkline (last 14 days)
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
    const cloud = await getCloudClient()
    if (!cloud) {
      logger.error('Indexing diagnostics requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const { siteId, siteUrl } = await resolveCloudSite(cloud, args.site || config.defaultSite)

    const data = await cloud.indexingDiagnostics(siteId).catch((e: Error) => {
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
    const cloud = await getCloudClient()
    if (!cloud) {
      logger.error('Indexing URLs requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const { siteId, siteUrl } = await resolveCloudSite(cloud, args.site || config.defaultSite)

    const params: Record<string, string> = {
      limit: String(args.limit),
      offset: String(args.offset),
    }
    if (args.status)
      params.status = String(args.status)
    if (args.issue)
      params.issue = String(args.issue)
    if (args.search)
      params.search = String(args.search)

    const data = await cloud.indexingUrls(siteId, params).catch((e: Error) => {
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
    description: 'Inspect a specific URL\'s indexing status (local mode)',
  },
  args: {
    site: { type: 'string', alias: 's', required: true, description: 'Site URL (e.g., sc-domain:example.com)' },
    url: { type: 'positional', required: true, description: 'URL to inspect' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const auth = await getAuth({ interactive: false })
    const client = googleSearchConsole(auth)
    const result = await gscInspectUrl(client, args.site, args.url).catch((e: Error) => {
      logger.error(`Inspection failed: ${e.message}`)
      process.exit(1)
    })

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    const r = result as Record<string, unknown>
    const inspection = r.inspectionResult as Record<string, unknown> | undefined
    const indexStatus = inspection?.indexStatusResult as Record<string, unknown> | undefined

    console.log()
    console.log(`  \x1B[1mURL:\x1B[0m ${args.url}`)
    console.log()

    if (indexStatus) {
      const verdict = indexStatus.verdict as string
      const verdictColor = verdict === 'PASS' ? '\x1B[32m' : '\x1B[31m'
      console.log(`  Verdict:        ${verdictColor}${verdict}\x1B[0m`)
      if (indexStatus.coverageState)
        console.log(`  Coverage:       ${indexStatus.coverageState}`)
      if (indexStatus.robotsTxtState)
        console.log(`  Robots.txt:     ${indexStatus.robotsTxtState}`)
      if (indexStatus.indexingState)
        console.log(`  Indexing:       ${indexStatus.indexingState}`)
      if (indexStatus.lastCrawlTime)
        console.log(`  Last Crawl:     ${indexStatus.lastCrawlTime}`)
      if (indexStatus.pageFetchState)
        console.log(`  Page Fetch:     ${indexStatus.pageFetchState}`)
      if (indexStatus.googleCanonical)
        console.log(`  Google Canon:   ${indexStatus.googleCanonical}`)
      if (indexStatus.userCanonical)
        console.log(`  User Canon:     ${indexStatus.userCanonical}`)
    }
    else {
      console.log(JSON.stringify(result, null, 2))
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
    const cloud = await getCloudClient()
    if (!cloud) {
      logger.error('Index percent requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const { siteId, siteUrl } = await resolveCloudSite(cloud, args.site || config.defaultSite)

    const data = await cloud.indexPercent(siteId).catch((e: Error) => {
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

    // Invisible URLs
    if (data.invisibleCount > 0) {
      console.log()
      console.log(`  \x1B[1mInvisible URLs\x1B[0m (\x1B[33m${data.invisibleCount}\x1B[0m — in sitemap but no search traffic)`)
      for (const u of data.invisibleUrls.slice(0, 10)) {
        console.log(`    ${u.url}`)
      }
      if (data.invisibleCount > 10)
        console.log(`    \x1B[90m... and ${data.invisibleCount - 10} more\x1B[0m`)
    }

    // Orphan pages
    if (data.orphanCount > 0) {
      console.log()
      console.log(`  \x1B[1mOrphan Pages\x1B[0m (\x1B[33m${data.orphanCount}\x1B[0m — has traffic but not in sitemap)`)
      for (const u of data.orphanPages.slice(0, 10)) {
        console.log(`    ${u.url} \x1B[90m(${u.clicks} clicks)\x1B[0m`)
      }
      if (data.orphanCount > 10)
        console.log(`    \x1B[90m... and ${data.orphanCount - 10} more\x1B[0m`)
    }

    // Sitemaps
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
