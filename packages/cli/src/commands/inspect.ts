import type { UrlInspectionResult } from 'gscdump/indexing'
import process from 'node:process'
import { defineCommand } from 'citty'
import { batchInspectUrls } from 'gscdump/indexing'
import { inspectCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { gscErrorHandler } from '../error-handler'
import { loadSitemapUrls } from '../sitemap'
import { applyOutputMode, logger, OUTPUT_ARGS, readUrlList } from '../utils'

function verdictTone(verdict: string | null | undefined): string {
  if (verdict === 'PASS')
    return '\x1B[32m'
  if (verdict === 'NEUTRAL' || verdict === 'PARTIAL')
    return '\x1B[33m'
  if (verdict === 'FAIL')
    return '\x1B[31m'
  return '\x1B[90m'
}

function colorVerdict(verdict: string | null | undefined): string {
  return `${verdictTone(verdict)}${verdict || 'N/A'}\x1B[0m`
}

function printInspection(url: string, inspection: UrlInspectionResult | undefined): void {
  const indexStatus = inspection?.indexStatusResult
  console.log()
  console.log(`  \x1B[1mURL:\x1B[0m ${url}`)
  console.log()
  console.log(`  \x1B[1mIndex status\x1B[0m`)
  console.log(`    Verdict:        ${colorVerdict(indexStatus?.verdict)}`)
  if (indexStatus?.coverageState)
    console.log(`    Coverage:       ${indexStatus.coverageState}`)
  if (indexStatus?.indexingState)
    console.log(`    Indexing:       ${indexStatus.indexingState}`)
  if (indexStatus?.lastCrawlTime)
    console.log(`    Last Crawl:     ${indexStatus.lastCrawlTime}`)
  if (indexStatus?.crawledAs)
    console.log(`    Crawled As:     ${indexStatus.crawledAs}`)
  if (indexStatus?.robotsTxtState)
    console.log(`    Robots.txt:     ${indexStatus.robotsTxtState}`)
  if (indexStatus?.pageFetchState)
    console.log(`    Page Fetch:     ${indexStatus.pageFetchState}`)
  if (indexStatus?.googleCanonical)
    console.log(`    Google Canon:   ${indexStatus.googleCanonical}`)
  if (indexStatus?.userCanonical)
    console.log(`    User Canon:     ${indexStatus.userCanonical}`)
  if (indexStatus?.sitemap?.length) {
    console.log(`    Sitemaps:`)
    for (const sm of indexStatus.sitemap)
      console.log(`      \x1B[90m└─\x1B[0m ${sm}`)
  }
  if (indexStatus?.referringUrls?.length) {
    const shown = indexStatus.referringUrls.slice(0, 5)
    console.log(`    Referring URLs (${indexStatus.referringUrls.length}):`)
    for (const r of shown)
      console.log(`      \x1B[90m└─\x1B[0m ${r}`)
    if (indexStatus.referringUrls.length > shown.length)
      console.log(`      \x1B[90m… ${indexStatus.referringUrls.length - shown.length} more\x1B[0m`)
  }

  const rich = inspection?.richResultsResult
  if (rich) {
    console.log()
    console.log(`  \x1B[1mRich results\x1B[0m`)
    console.log(`    Verdict:        ${colorVerdict(rich.verdict)}`)
    if (rich.detectedItems?.length) {
      for (const group of rich.detectedItems) {
        const count = group.items?.length ?? 0
        console.log(`    ${group.richResultType ?? 'unknown'}: ${count} item${count === 1 ? '' : 's'}`)
        for (const item of group.items ?? []) {
          if (item.issues?.length) {
            for (const issue of item.issues) {
              const sev = issue.severity === 'ERROR' ? '\x1B[31m' : '\x1B[33m'
              console.log(`      ${sev}${issue.severity ?? '?'}\x1B[0m ${item.name ?? ''}: ${issue.issueMessage ?? ''}`)
            }
          }
        }
      }
    }
  }

  const amp = inspection?.ampResult
  if (amp) {
    console.log()
    console.log(`  \x1B[1mAMP\x1B[0m`)
    console.log(`    Verdict:        ${colorVerdict(amp.verdict)}`)
    if (amp.ampUrl)
      console.log(`    AMP URL:        ${amp.ampUrl}`)
    if (amp.ampIndexStatusVerdict)
      console.log(`    Index Verdict:  ${amp.ampIndexStatusVerdict}`)
    if (amp.indexingState)
      console.log(`    Indexing:       ${amp.indexingState}`)
    if (amp.robotsTxtState)
      console.log(`    Robots.txt:     ${amp.robotsTxtState}`)
    if (amp.pageFetchState)
      console.log(`    Page Fetch:     ${amp.pageFetchState}`)
    if (amp.lastCrawlTime)
      console.log(`    Last Crawl:     ${amp.lastCrawlTime}`)
    if (amp.issues?.length) {
      for (const issue of amp.issues) {
        const sev = issue.severity === 'ERROR' ? '\x1B[31m' : '\x1B[33m'
        console.log(`    ${sev}${issue.severity ?? '?'}\x1B[0m ${issue.issueMessage ?? ''}`)
      }
    }
  }

  if (inspection?.inspectionResultLink) {
    console.log()
    console.log(`  \x1B[90mOpen in Search Console:\x1B[0m \x1B[36m${inspection.inspectionResultLink}\x1B[0m`)
  }
  console.log()
}

const batchCommand = defineCommand({
  meta: {
    name: 'batch',
    description: 'Inspect many URLs from a file or stdin (one URL per line)',
  },
  args: {
    ...OUTPUT_ARGS,
    'site': { type: 'string', alias: 's', description: 'Site URL (defaults to config.defaultSite or prompt)' },
    'urls': { type: 'positional', required: false, description: 'URLs (or use --file/--from-sitemap/stdin)' },
    'file': { type: 'string', alias: 'f', description: 'File with URLs (one per line)' },
    'from-sitemap': { type: 'string', description: 'Sitemap URL (or sitemap index) to pull URLs from' },
    'delay-ms': { type: 'string', default: '200', description: 'Delay between requests' },
    'concurrency': { type: 'string', alias: 'c', default: '1', description: 'Concurrent in-flight requests' },
  },
  async run({ args }) {
    const { json, quiet } = applyOutputMode(args)
    let urls: string[]
    if (args['from-sitemap']) {
      const result = await loadSitemapUrls(String(args['from-sitemap']))
      if (result._tag === 'error') {
        logger.error(`Sitemap fetch failed: ${result.message}`)
        process.exit(1)
      }
      if (!result.value.complete)
        logger.warn('Sitemap walk was incomplete; inspecting only the URLs that were read')
      urls = result.value.urls
    }
    else {
      urls = await readUrlList(args)
    }
    if (urls.length === 0) {
      logger.error('No URLs provided. Pass URLs as args, --file, --from-sitemap, or stdin.')
      process.exit(1)
    }
    const ctx = await createCommandContext({ needsAuth: true })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const delayMs = Number.parseInt(String(args['delay-ms']), 10)
    const concurrency = Math.max(1, Number.parseInt(String(args.concurrency), 10) || 1)
    if (!quiet)
      logger.info(`Inspecting ${urls.length} URLs ...`)

    const results = await batchInspectUrls(ctx.client!, siteUrl, urls, {
      delayMs,
      concurrency,
      onProgress: quiet
        ? undefined
        : (r, i, total) => logger.info(`[${i + 1}/${total}] ${r.url} ${r.isIndexed ? 'PASS' : 'FAIL'}`),
    }).catch(gscErrorHandler)

    if (json) {
      const flattened = results.map((r) => {
        const indexStatus = r.inspection?.indexStatusResult
        return {
          url: r.url,
          verdict: indexStatus?.verdict || null,
          coverageState: indexStatus?.coverageState || null,
          indexingState: indexStatus?.indexingState || null,
          lastCrawlTime: indexStatus?.lastCrawlTime || null,
          isIndexed: r.isIndexed,
          raw: r.inspection,
        }
      })
      console.log(JSON.stringify(flattened, null, 2))
      return
    }
    const indexed = results.filter(r => r.isIndexed).length
    if (!quiet)
      logger.success(`Inspected ${results.length} URLs (${indexed} indexed, ${results.length - indexed} not)`)
  },
})

export const inspectCommand = defineCommand({
  meta: inspectCommandMeta,
  args: {
    ...OUTPUT_ARGS,
    site: { type: 'string', alias: 's', description: 'Site URL (defaults to config.defaultSite or prompt)' },
    url: { type: 'positional', required: true, description: 'URL to inspect' },
  },
  subCommands: {
    batch: batchCommand,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const result = await ctx.client!.inspect(siteUrl, args.url).catch(gscErrorHandler)
    const inspection = result?.inspectionResult
    const indexStatus = inspection?.indexStatusResult

    if (json) {
      console.log(JSON.stringify({
        url: args.url,
        verdict: indexStatus?.verdict || null,
        coverageState: indexStatus?.coverageState || null,
        indexingState: indexStatus?.indexingState || null,
        lastCrawlTime: indexStatus?.lastCrawlTime || null,
        isIndexed: indexStatus?.verdict === 'PASS',
        raw: result,
      }, null, 2))
      return
    }

    printInspection(args.url, inspection)
  },
})
