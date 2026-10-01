import type { GscdumpV1OperationResponse } from '@gscdump/sdk/v1'
import type { SiteManager } from '../auth-state'
import { WATCHED_URL_LIMIT } from '@gscdump/contracts'
import { defineCommand } from 'citty'
import { siteSettingsPlace } from '../auth-state'
import { HOSTED_ARGS, resolveHostedSite } from '../hosted-site'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { applyOutputMode, logger, readUrlList } from '../utils'

type WatchedUrls = GscdumpV1OperationResponse<'partner.sites.indexing.watched.list'>['data']
type WatchedUrlsChange = GscdumpV1OperationResponse<'partner.sites.indexing.watched.add'>['data']

const OUTPUT = {
  json: { type: 'boolean' as const, default: false, description: 'Output as JSON' },
  quiet: { type: 'boolean' as const, alias: 'q' as const, default: false, description: 'Suppress info output' },
}

const URL_ARGS = {
  urls: { type: 'positional' as const, required: false, description: 'URLs on the Site host (or use --file or stdin)' },
  file: { type: 'string' as const, alias: 'f', description: 'File with URLs (one per line)' },
}

const LOCAL_ALTERNATIVE = 'run `gscdump inspect --site <site> <url...>` on your own schedule'

function watchedRow(entry: WatchedUrls['watched'][number]): Record<string, unknown> {
  const latest = entry.checkpoints[0]
  return {
    url: entry.url,
    coverageState: latest?.coverageState ?? 'awaiting inspection',
    checkedAt: latest?.checkedAt.slice(0, 10) ?? 'never',
    dueAt: entry.dueAt.slice(0, 10),
  }
}

function skipHint(reason: WatchedUrlsChange['skipped'][number]['reason'], manager: SiteManager): string | undefined {
  return reason === 'inspection_disabled'
    ? `gscdump never inspects this Site, so a Watched URL gets no Checkpoint. To use Watched URLs, turn on URL Inspection ${siteSettingsPlace(manager)}.`
    : undefined
}

function printChange(verb: 'Added' | 'Removed', result: WatchedUrlsChange, siteUrl: string, manager: SiteManager): void {
  for (const url of result.changed)
    console.log(`${verb}: ${url}`)
  for (const url of result.unchanged)
    console.log(`${verb === 'Added' ? 'Already watched' : 'Not watched'}: ${url}`)
  for (const { url, reason } of result.skipped)
    console.log(`Skipped (${reason}): ${url}`)
  for (const hint of new Set(result.skipped.map(({ reason }) => skipHint(reason, manager)).filter(Boolean)))
    console.log(hint)
  logger.info(`${siteUrl} has ${result.total} of ${result.limit} Watched URLs.`)
}

async function readUrls(args: { _?: unknown[], file?: unknown }): Promise<string[]> {
  const urls = await readUrlList({ file: args.file, positionals: args._ })
  if (urls.length === 0)
    throw new Error('No URLs provided. Pass URLs as arguments, --file, or stdin.')
  const relative = urls.find(url => !URL.canParse(url))
  if (relative)
    throw new Error(`Not an absolute URL: ${relative}. Pass full URLs such as https://example.com/guide.`)
  return [...new Set(urls)]
}

/** Send URLs in requests of at most `WATCHED_URL_LIMIT`, and merge the per-request results into one. */
async function changeInChunks(
  urls: string[],
  send: (chunk: string[]) => Promise<WatchedUrlsChange>,
): Promise<WatchedUrlsChange> {
  const merged: WatchedUrlsChange = { changed: [], unchanged: [], skipped: [], total: 0, limit: WATCHED_URL_LIMIT }
  for (let start = 0; start < urls.length; start += WATCHED_URL_LIMIT) {
    const result = await send(urls.slice(start, start + WATCHED_URL_LIMIT))
    merged.changed.push(...result.changed)
    merged.unchanged.push(...result.unchanged)
    merged.skipped.push(...result.skipped)
    // Total and limit describe the Site after the request, so the last request wins.
    merged.total = result.total
    merged.limit = result.limit
  }
  return merged
}

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List Watched URLs with the latest Checkpoint of each (hosted)',
  },
  args: { ...HOSTED_ARGS, ...OUTPUT },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { client, site } = await resolveHostedSite(args, { name: 'indexing watch list', localAlternative: LOCAL_ALTERNATIVE })
    const { data } = await client.listSiteWatchedUrls({ params: { siteId: site.siteId } })
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    if (data.watched.length === 0) {
      logger.info(`${site.siteUrl} has no Watched URLs.`)
      return
    }
    for (const line of renderTable(data.watched.map(watchedRow), [
      { key: 'url', label: 'URL' },
      { key: 'coverageState', label: 'Coverage state' },
      { key: 'checkedAt', label: 'Checked' },
      { key: 'dueAt', label: 'Due' },
    ], terminalOutputOptions())) {
      console.log(line)
    }
    logger.info(`${data.watched.length} of ${data.limit} Watched URLs. gscdump inspects each one every ${data.cadenceDays} days.`)
  },
})

const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Add Watched URLs, inspected every 7 days before other URLs (hosted; spends URL Inspections)',
  },
  args: { ...HOSTED_ARGS, ...URL_ARGS, ...OUTPUT },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const urls = await readUrls(args)
    const { client, site, siteManager } = await resolveHostedSite({ ...args, _: [] }, { name: 'indexing watch add', localAlternative: LOCAL_ALTERNATIVE })
    const data = await changeInChunks(urls, async chunk => (await client.addSiteWatchedUrls({ params: { siteId: site.siteId }, body: { urls: chunk } })).data)
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    printChange('Added', data, site.siteUrl, siteManager)
  },
})

const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove Watched URLs and their Checkpoints (hosted)',
  },
  args: { ...HOSTED_ARGS, ...URL_ARGS, ...OUTPUT },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const urls = await readUrls(args)
    const { client, site, siteManager } = await resolveHostedSite({ ...args, _: [] }, { name: 'indexing watch remove', localAlternative: LOCAL_ALTERNATIVE })
    const data = await changeInChunks(urls, async chunk => (await client.removeSiteWatchedUrls({ params: { siteId: site.siteId }, body: { urls: chunk } })).data)
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    printChange('Removed', data, site.siteUrl, siteManager)
  },
})

export const indexingWatchCommand = defineCommand({
  meta: {
    name: 'watch',
    description: 'Manage Watched URLs: a Site\'s URLs inspected on a fixed 7 day cadence (hosted)',
  },
  subCommands: {
    list: listCommand,
    add: addCommand,
    remove: removeCommand,
  },
})
