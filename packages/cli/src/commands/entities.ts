import type { TenantCtx } from '@gscdump/engine/contracts'
import type { IndexingMetadataRecord, InspectionRecord, InspectionStore } from '@gscdump/engine/entities'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import {
  createIndexingMetadataStore,
  createInspectionStore,
} from '@gscdump/engine/entities'
import { defineCommand } from 'citty'
import { entitiesCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { applyOutputMode, logger, OUTPUT_ARGS, progressBar, runWithConcurrency } from '../utils'

const INSPECTION_QPD_PER_PROPERTY = 2000
const INDEXING_NOT_FOUND_RE = /\b404\b|NOT_FOUND/i

// The redesigned InspectionStore is append-only history shards bucketed by the
// `inspectedAt` month (no JSON index / point-lookup API). `entities show`
// reconstructs a point lookup by scanning recent month shards newest-first; the
// first month holding the URL has its latest inspection, since a record's
// bucket is its own inspection month.
const INSPECTION_HISTORY_LOOKBACK_MONTHS = 24

async function findLatestInspection(
  inspector: InspectionStore,
  ctx: TenantCtx,
  url: string,
): Promise<InspectionRecord | undefined> {
  const now = new Date()
  const buckets: string[] = []
  for (let i = 0; i < INSPECTION_HISTORY_LOOKBACK_MONTHS; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    buckets.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  // Records with a malformed `inspectedAt` land in the `unknown` bucket; check
  // it last so a real dated record always wins.
  buckets.push('unknown')
  for (const yearMonth of buckets) {
    const shard = await inspector.loadHistory(ctx, yearMonth)
    const matches = shard?.records.filter(r => r.url === url) ?? []
    if (matches.length > 0)
      return matches.reduce((a, b) => (a.inspectedAt >= b.inspectedAt ? a : b))
  }
  return undefined
}

async function readUrlList(opts: { file?: string }): Promise<string[]> {
  if (opts.file) {
    const text = await readFile(opts.file, 'utf8')
    return text.split('\n').map(l => l.trim()).filter(Boolean)
  }
  // Read URLs from stdin (one per line) so this composes with `gscdump query`,
  // `cat sitemap.txt`, etc.
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').split('\n').map(l => l.trim()).filter(Boolean)
}

const inspectSubCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'Run URL Inspection for a list of URLs and persist results to the local entity store',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com); defaults to config.defaultSite or prompt',
    },
    file: {
      type: 'string',
      alias: 'f',
      description: 'Path to a file with one URL per line. If omitted, reads from stdin.',
    },
    limit: {
      type: 'string',
      description: `Max URLs to inspect this run (default: ${INSPECTION_QPD_PER_PROPERTY}, the per-property GSC daily quota)`,
    },
    concurrency: {
      type: 'string',
      alias: 'c',
      default: '4',
      description: 'Concurrent in-flight inspect calls (default: 4)',
    },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json, quiet } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
    const client = ctx.client!
    const store = ctx.store!
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const limit = args.limit ? Number.parseInt(String(args.limit), 10) : INSPECTION_QPD_PER_PROPERTY
    const concurrency = Math.max(1, Number.parseInt(String(args.concurrency), 10) || 4)

    const urls = (await readUrlList({ file: args.file ? String(args.file) : undefined })).slice(0, limit)
    if (urls.length === 0) {
      logger.warn('No URLs to inspect.')
      return
    }
    if (urls.length === limit && limit < INSPECTION_QPD_PER_PROPERTY)
      logger.info(`Capping at --limit ${limit}`)
    if (urls.length === INSPECTION_QPD_PER_PROPERTY)
      logger.info(`Hit per-property daily inspection quota (${INSPECTION_QPD_PER_PROPERTY}); remaining URLs will be queued for tomorrow.`)

    const inspector = createInspectionStore({ dataSource: store.dataSource })

    let completed = 0
    let failed = 0
    const records: InspectionRecord[] = []
    const failures: Array<{ url: string, error: string }> = []

    await runWithConcurrency(urls, concurrency, async (url) => {
      const result = await client.inspect(siteUrl, url).catch((err: Error) => err)
      if (result instanceof Error) {
        failed++
        failures.push({ url, error: result.message })
      }
      else {
        const ix = result.inspectionResult
        const indexStatus = ix?.indexStatusResult
        records.push({
          url,
          inspectedAt: new Date().toISOString(),
          indexStatus: indexStatus?.verdict ?? undefined,
          lastCrawlTime: indexStatus?.lastCrawlTime ?? undefined,
          googleCanonical: indexStatus?.googleCanonical ?? undefined,
          userCanonical: indexStatus?.userCanonical ?? undefined,
          coverageState: indexStatus?.coverageState ?? undefined,
          robotsTxtState: indexStatus?.robotsTxtState ?? undefined,
          indexingState: indexStatus?.indexingState ?? undefined,
          pageFetchState: indexStatus?.pageFetchState ?? undefined,
          mobileUsabilityVerdict: ix?.mobileUsabilityResult?.verdict ?? undefined,
          richResultsVerdict: ix?.richResultsResult?.verdict ?? undefined,
          raw: ix as Record<string, unknown> | undefined,
        })
      }
      completed++
      if (!quiet)
        process.stdout.write(`\r${progressBar(completed, urls.length, `${url.slice(0, 60)}`)}`)
    })

    if (!quiet)
      process.stdout.write('\n')

    await inspector.appendHistory(
      { userId: store.userId, siteId: store.siteIdFor(siteUrl) },
      records,
    )

    if (json) {
      console.log(JSON.stringify({
        site: siteUrl,
        inspected: records.length,
        failed,
        failures,
        records,
      }, null, 2))
    }
    else if (!quiet) {
      logger.success(`Inspected ${records.length}/${urls.length} URL(s)`)
      if (failed > 0) {
        logger.warn(`${failed} failed:`)
        for (const f of failures.slice(0, 5))
          console.log(`  ${f.url}: ${f.error}`)
        if (failures.length > 5)
          console.log(`  ... and ${failures.length - 5} more`)
      }
    }

    if (failed > 0)
      process.exit(1)
  },
})

const showSubCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Print the latest inspection record for a URL from the local entity store',
  },
  args: {
    ...OUTPUT_ARGS,
    site: { type: 'string', alias: 's', description: 'Site URL (defaults to config.defaultSite or prompt)' },
    url: { type: 'positional', required: true, description: 'URL to look up' },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
    const store = ctx.store!
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const inspector = createInspectionStore({ dataSource: store.dataSource })
    const record = await findLatestInspection(
      inspector,
      { userId: store.userId, siteId: store.siteIdFor(siteUrl) },
      String(args.url),
    )
    if (!record) {
      logger.warn(`No inspection record for ${args.url}`)
      process.exit(1)
    }
    if (json) {
      console.log(JSON.stringify(record, null, 2))
      return
    }
    console.log()
    console.log(`  \x1B[1m${record.url}\x1B[0m`)
    console.log(`  Inspected:    ${record.inspectedAt}`)
    if (record.indexStatus)
      console.log(`  Index:        ${record.indexStatus}`)
    if (record.lastCrawlTime)
      console.log(`  Last crawl:   ${record.lastCrawlTime}`)
    if (record.googleCanonical)
      console.log(`  Canonical:    ${record.googleCanonical}`)
    if (record.coverageState)
      console.log(`  Coverage:     ${record.coverageState}`)
    if (record.richResultsVerdict)
      console.log(`  Rich results: ${record.richResultsVerdict}`)
    console.log()
  },
})

const indexingSnapshotSubCommand = defineCommand({
  meta: {
    name: 'snapshot',
    description: 'Fetch Indexing API metadata (latest update/remove per URL) and persist to the local entity store',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com); defaults to config.defaultSite or prompt',
    },
    file: {
      type: 'string',
      alias: 'f',
      description: 'Path to a file with one URL per line. If omitted, reads from stdin.',
    },
    concurrency: {
      type: 'string',
      alias: 'c',
      default: '4',
      description: 'Concurrent in-flight getMetadata calls (default: 4)',
    },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { quiet } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
    const client = ctx.client!
    const store = ctx.store!
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const concurrency = Math.max(1, Number.parseInt(String(args.concurrency), 10) || 4)

    const urls = await readUrlList({ file: args.file ? String(args.file) : undefined })
    if (urls.length === 0) {
      logger.warn('No URLs to fetch metadata for.')
      return
    }

    const records: IndexingMetadataRecord[] = []
    const failures: Array<{ url: string, error: string }> = []
    let completed = 0

    await runWithConcurrency(urls, concurrency, async (url) => {
      const result = await client.indexing.getMetadata(url).catch((err: Error) => err)
      if (result instanceof Error) {
        // 404 from the API just means "no notification on record" — treat
        // as a recorded absence, not a failure.
        if (INDEXING_NOT_FOUND_RE.test(result.message)) {
          records.push({ url, capturedAt: new Date().toISOString() })
        }
        else {
          failures.push({ url, error: result.message })
        }
      }
      else {
        records.push({
          url,
          capturedAt: new Date().toISOString(),
          latestUpdateAt: result.latestUpdate?.notifyTime ?? undefined,
          latestRemoveAt: result.latestRemove?.notifyTime ?? undefined,
          raw: result,
        })
      }
      completed++
      if (!quiet)
        process.stdout.write(`\r${progressBar(completed, urls.length, url.slice(0, 60))}`)
    })

    if (!quiet)
      process.stdout.write('\n')

    const indexing = createIndexingMetadataStore({ dataSource: store.dataSource })
    await indexing.writeBatch(
      { userId: store.userId, siteId: store.siteIdFor(siteUrl) },
      records,
    )

    if (!quiet) {
      logger.success(`Captured metadata for ${records.length}/${urls.length} URL(s)`)
      if (failures.length > 0) {
        logger.warn(`${failures.length} failed:`)
        for (const f of failures.slice(0, 5))
          console.log(`  ${f.url}: ${f.error}`)
        if (failures.length > 5)
          console.log(`  ... and ${failures.length - 5} more`)
      }
    }

    if (failures.length > 0)
      process.exit(1)
  },
})

const indexingSubCommand = defineCommand({
  meta: {
    name: 'indexing',
    description: 'Snapshot Indexing API metadata per URL',
  },
  subCommands: {
    snapshot: indexingSnapshotSubCommand,
  },
})

export const entitiesCommand = defineCommand({
  meta: entitiesCommandMeta,
  subCommands: {
    inspect: inspectSubCommand,
    show: showSubCommand,
    indexing: indexingSubCommand,
  },
})
