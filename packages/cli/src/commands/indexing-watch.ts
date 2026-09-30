import type { GscdumpV1OperationResponse } from '@gscdump/sdk/v1'
import { defineCommand } from 'citty'
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

function printChange(verb: 'Added' | 'Removed', result: WatchedUrlsChange, siteUrl: string): void {
  for (const url of result.changed)
    console.log(`${verb}: ${url}`)
  for (const url of result.unchanged)
    console.log(`${verb === 'Added' ? 'Already watched' : 'Not watched'}: ${url}`)
  for (const { url, reason } of result.skipped)
    console.log(`Skipped (${reason}): ${url}`)
  logger.info(`${siteUrl} has ${result.total} of ${result.limit} Watched URLs.`)
}

async function readUrls(args: { _?: unknown[], file?: unknown }): Promise<string[]> {
  const urls = await readUrlList({ file: args.file, positionals: args._ })
  if (urls.length === 0)
    throw new Error('No URLs provided. Pass URLs as arguments, --file, or stdin.')
  return urls
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
    const { client, site } = await resolveHostedSite({ ...args, _: [] }, { name: 'indexing watch add', localAlternative: LOCAL_ALTERNATIVE })
    const { data } = await client.addSiteWatchedUrls({ params: { siteId: site.siteId }, body: { urls } })
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    printChange('Added', data, site.siteUrl)
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
    const { client, site } = await resolveHostedSite({ ...args, _: [] }, { name: 'indexing watch remove', localAlternative: LOCAL_ALTERNATIVE })
    const { data } = await client.removeSiteWatchedUrls({ params: { siteId: site.siteId }, body: { urls } })
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    printChange('Removed', data, site.siteUrl)
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
