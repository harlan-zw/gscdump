import process from 'node:process'
import { defineCommand } from 'citty'
import { batchRequestIndexing, getIndexingMetadata, requestIndexing } from 'gscdump'
import { createCommandContext } from '../context'
import { gscErrorHandler } from '../error-handler'
import { logger, readUrlList, setQuiet } from '../utils'

const RETRIES_ARG = {
  retries: { type: 'string' as const, description: 'Override per-call retry count (default: 3)' },
}

function parseRetries(v: unknown): number | undefined {
  if (v == null || v === '')
    return undefined
  const n = Number.parseInt(String(v), 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const submitCommand = defineCommand({
  meta: {
    name: 'submit',
    description: 'Notify Google of a new or updated URL (URL_UPDATED)',
  },
  args: {
    url: { type: 'positional', required: true, description: 'URL to submit' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
    ...RETRIES_ARG,
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const ctx = await createCommandContext({ needsAuth: true, fetchOptions: { retry: parseRetries(args.retries) } })
    const result = await requestIndexing(ctx.client!, args.url, { type: 'URL_UPDATED' }).catch(gscErrorHandler)
    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    logger.success(`Submitted: ${result.url}`)
    if (result.notifyTime)
      console.log(`  Notified: ${result.notifyTime}`)
  },
})

const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Notify Google a URL has been removed (URL_DELETED)',
  },
  args: {
    url: { type: 'positional', required: true, description: 'URL to mark removed' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
    ...RETRIES_ARG,
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const ctx = await createCommandContext({ needsAuth: true, fetchOptions: { retry: parseRetries(args.retries) } })
    const result = await requestIndexing(ctx.client!, args.url, { type: 'URL_DELETED' }).catch(gscErrorHandler)
    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    logger.success(`Removed: ${result.url}`)
    if (result.notifyTime)
      console.log(`  Notified: ${result.notifyTime}`)
  },
})

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show indexing notification metadata for a URL',
  },
  args: {
    url: { type: 'positional', required: true, description: 'URL to inspect' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const ctx = await createCommandContext({ needsAuth: true })
    const meta = await getIndexingMetadata(ctx.client!, args.url).catch(gscErrorHandler)
    if (args.json) {
      console.log(JSON.stringify(meta, null, 2))
      return
    }
    const fmtNotification = (n: { notifyTime?: string, type?: string } | undefined): string => {
      if (!n?.notifyTime)
        return 'never'
      return n.type ? `${n.notifyTime} (${n.type})` : n.notifyTime
    }
    const update = meta.latestUpdate as { notifyTime?: string, type?: string } | undefined
    const remove = meta.latestRemove as { notifyTime?: string, type?: string } | undefined
    console.log()
    console.log(`  \x1B[1mURL:\x1B[0m ${meta.url}`)
    console.log(`  Last update notify: ${fmtNotification(update)}`)
    console.log(`  Last remove notify: ${fmtNotification(remove)}`)
    console.log()
  },
})

const INDEXING_DAILY_QUOTA = 200

const batchCommand = defineCommand({
  meta: {
    name: 'batch',
    description: 'Submit many URLs from a file or stdin (one URL per line)',
  },
  args: {
    'urls': { type: 'positional', required: false, description: 'URLs (or use --file/stdin)' },
    'file': { type: 'string', alias: 'f', description: 'File with URLs (one per line)' },
    'type': { type: 'string', default: 'URL_UPDATED', description: 'URL_UPDATED or URL_DELETED' },
    'delay-ms': { type: 'string', default: '100', description: 'Delay between requests' },
    'concurrency': { type: 'string', alias: 'c', default: '1', description: 'Concurrent in-flight requests' },
    'quiet': { type: 'boolean', alias: 'q', default: false, description: 'Suppress progress output' },
    'json': { type: 'boolean', default: false, description: 'Output as JSON' },
    'yes': { type: 'boolean', alias: 'y', default: false, description: 'Skip the over-quota confirmation prompt' },
    'retries': { type: 'string', description: 'Override per-call retry count (default: 3)' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const urls = await readUrlList(args)
    if (urls.length === 0) {
      logger.error('No URLs provided. Pass URLs as args, --file, or stdin.')
      process.exit(1)
    }
    const type = String(args.type) as 'URL_UPDATED' | 'URL_DELETED'
    if (type !== 'URL_UPDATED' && type !== 'URL_DELETED') {
      logger.error(`Invalid --type: ${type}. Use URL_UPDATED or URL_DELETED.`)
      process.exit(1)
    }

    if (urls.length > INDEXING_DAILY_QUOTA && !args.yes && !args.json) {
      logger.warn(`Submitting ${urls.length} URLs but the Indexing API daily quota is ${INDEXING_DAILY_QUOTA}/day.`)
      logger.warn(`Excess submissions will fail with quota errors. Pass --yes to proceed anyway.`)
      process.exit(1)
    }
    if (urls.length > INDEXING_DAILY_QUOTA && !args.json && !args.quiet)
      logger.warn(`Proceeding with ${urls.length} URLs (over the ${INDEXING_DAILY_QUOTA}/day quota). Excess will fail.`)

    const ctx = await createCommandContext({ needsAuth: true, fetchOptions: { retry: parseRetries(args.retries) } })
    const delayMs = Number.parseInt(String(args['delay-ms']), 10)
    const concurrency = Math.max(1, Number.parseInt(String(args.concurrency), 10) || 1)

    if (!args.json && !args.quiet)
      logger.info(`Submitting ${urls.length} URLs (${type}) ...`)

    const results = await batchRequestIndexing(ctx.client!, urls, {
      type,
      delayMs,
      concurrency,
      onProgress: (args.json || args.quiet)
        ? undefined
        : (r, i, total) => logger.info(`[${i + 1}/${total}] ${r.url}`),
    }).catch(gscErrorHandler)

    if (args.json) {
      console.log(JSON.stringify(results, null, 2))
      return
    }
    if (!args.quiet)
      logger.success(`Submitted ${results.length}/${urls.length} URLs`)
  },
})

export const indexingCommand = defineCommand({
  meta: {
    name: 'indexing',
    description: 'Notify Google about URL updates/removals (Indexing API)',
  },
  subCommands: {
    submit: submitCommand,
    remove: removeCommand,
    status: statusCommand,
    batch: batchCommand,
  },
})
