import type { InspectionRecord } from '@gscdump/engine/entities'
import type { UrlInspectionResult } from 'gscdump/indexing'
import type { InspectOutcome } from '../inspect-urls'
import { defineCommand } from 'citty'
import { inspectCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { checkInspectionBatch, inspectUrls } from '../inspect-urls'
import { toInspectionRecord } from '../inspection-record'
import { appendInspections, loadInspectionState, materializeInspectionIndex, urlInProperty } from '../local-entities'
import { applyOutputMode, dim, logger, OUTPUT_ARGS, readUrlList, red } from '../utils'

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

function outcomeJson(outcome: InspectOutcome): Record<string, unknown> {
  if (outcome.kind === 'failed')
    return { url: outcome.url, status: 'failed', error: outcome.error }
  const indexStatus = outcome.result?.indexStatusResult
  return {
    url: outcome.url,
    status: 'inspected',
    verdict: indexStatus?.verdict ?? null,
    coverageState: indexStatus?.coverageState ?? null,
    indexingState: indexStatus?.indexingState ?? null,
    lastCrawlTime: indexStatus?.lastCrawlTime ?? null,
    isIndexed: indexStatus?.verdict === 'PASS',
    raw: outcome.result ?? null,
  }
}

function printOutcomeLine(outcome: InspectOutcome): void {
  if (outcome.kind === 'failed') {
    console.log(`  ${red('ERROR')}  ${outcome.url}  ${dim(outcome.error)}`)
    return
  }
  const indexStatus = outcome.result?.indexStatusResult
  console.log(`  ${colorVerdict(indexStatus?.verdict)}  ${outcome.url}  ${dim(indexStatus?.coverageState ?? '')}`)
}

export const inspectCommand = defineCommand({
  meta: inspectCommandMeta,
  args: {
    ...OUTPUT_ARGS,
    site: { type: 'string', alias: 's', description: 'Site URL (defaults to config.defaultSite or prompt)' },
    urls: { type: 'positional', required: false, description: 'One or more URLs to inspect' },
    file: { type: 'string', alias: 'f', description: 'File with URLs, one per line' },
  },
  async run({ args }) {
    const { json, quiet } = applyOutputMode(args)
    const urls = [...new Set(await readUrlList({ file: args.file, positionals: args._ }))]
    if (urls.length === 0)
      throw new Error('No URLs given. Pass URLs as arguments, use --file, or pipe them on stdin.')
    const batch = checkInspectionBatch(urls)
    if (batch.kind === 'too-many')
      throw new Error(batch.message)

    const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
    const client = ctx.client!
    const store = ctx.store!
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const tenant = { userId: store.userId, siteId: store.siteIdFor(siteUrl) }
    const { latest } = await loadInspectionState(store.dataSource, tenant, new Date())
    const saved: InspectionRecord[] = []

    if (!quiet && urls.length > 1)
      logger.info(`Inspecting ${urls.length} URLs ...`)
    const run = await inspectUrls({
      urls,
      inspect: async url => (await client.inspect(siteUrl, url)).inspectionResult,
      inProperty: url => urlInProperty(siteUrl, url),
      onOutcome: async (outcome) => {
        if (outcome.kind === 'inspected') {
          // Save each result as it arrives: a quota stop keeps the finished work.
          const record = toInspectionRecord({ url: outcome.url, result: outcome.result, inspectedAt: new Date(), previous: latest.get(outcome.url) })
          await appendInspections(store.dataSource, tenant, [record])
          saved.push(record)
        }
        if (!json && urls.length > 1)
          printOutcomeLine(outcome)
      },
    })
    if (saved.length > 0)
      await materializeInspectionIndex(store.dataSource, tenant, latest, saved)

    const failed = run.outcomes.filter(outcome => outcome.kind === 'failed')
    const remaining = run.stopped?.remaining ?? 0
    if (json) {
      console.log(JSON.stringify({
        site: siteUrl,
        inspected: saved.length,
        failed: failed.length,
        remaining,
        ...(run.stopped ? { stoppedReason: run.stopped.reason } : {}),
        results: run.outcomes.map(outcomeJson),
      }, null, 2))
    }
    else if (urls.length === 1 && run.outcomes[0]?.kind === 'inspected') {
      printInspection(run.outcomes[0].url, run.outcomes[0].result)
    }
    else if (urls.length === 1 && run.outcomes[0]?.kind === 'failed') {
      throw new Error(run.outcomes[0].error)
    }

    const summary = [saved.length > 0
      ? `Inspected ${saved.length} of ${urls.length} URL${urls.length === 1 ? '' : 's'} and saved the results to the Store.`
      : `Inspected ${saved.length} of ${urls.length} URL${urls.length === 1 ? '' : 's'}. Nothing was saved to the Store.`]
    if (failed.length > 0)
      summary.push(`${failed.length} failed.`)
    if (run.stopped)
      summary.push(`${remaining} remaining. ${run.stopped.reason} Run the command again after the quota resets.`)
    if (failed.length > 0 || run.stopped)
      throw new Error(summary.join(' '))
    if (!quiet)
      logger.success(summary[0])
  },
})
