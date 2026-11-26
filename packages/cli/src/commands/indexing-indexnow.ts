import type { IndexNowConnectionV1, IndexNowSubmissionReceiptV1 } from '@gscdump/contracts/v1'
import crypto from 'node:crypto'
import { defineCommand } from 'citty'
import { HOSTED_ARGS, resolveHostedSite, resolveHostedSiteWithTarget } from '../hosted-site'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { commandLineError } from '../stop'
import { applyOutputMode, logger, OUTPUT_ARGS, parseIntegerOption, readUrlList } from '../utils'

const LOCAL_ALTERNATIVE = 'submit IndexNow notifications directly to https://api.indexnow.org/indexnow'
const MAX_INDEXNOW_URLS = 1000

function printConnection(siteUrl: string, connection: IndexNowConnectionV1): void {
  console.log(`${siteUrl}: ${connection._tag} (host: ${connection.host})`)
  if (connection._tag === 'disconnected')
    return
  console.log(`  Key location:      ${connection.keyLocation}`)
  if (connection._tag === 'connected')
    console.log(`  Verified at:       ${connection.verifiedAt}`)
  else if (connection.reason)
    console.log(`  Reason:            ${connection.reason}`)
  const auto = connection.automaticSending
  console.log(`  Automatic sending: ${auto._tag === 'on' ? `on (since ${auto.since})` : 'off'}`)
}

function printReceipt(receipt: IndexNowSubmissionReceiptV1): void {
  console.log(`Submission receipt ${receipt.id}: ${receipt._tag} (${receipt.urls.length} URL${receipt.urls.length === 1 ? '' : 's'}, trigger: ${receipt.trigger})`)
  if (receipt.httpStatus !== null)
    console.log(`  HTTP status: ${receipt.httpStatus}`)
  if (receipt.reason)
    console.log(`  Reason:      ${receipt.reason}`)
  if (receipt.retryAt)
    console.log(`  Retry at:    ${receipt.retryAt}`)
}

async function runIndexNowStatus(args: Record<string, unknown>, positionalTarget?: string): Promise<void> {
  const { json } = applyOutputMode(args)
  const { client, site } = await resolveHostedSiteWithTarget(
    args,
    { name: 'indexing indexnow status', localAlternative: LOCAL_ALTERNATIVE },
    positionalTarget,
  )
  const { data } = await client.getSiteIndexNowConnection({ params: { siteId: site.siteId } })
  if (json) {
    console.log(JSON.stringify({ siteId: site.siteId, siteUrl: site.siteUrl, connection: data }, null, 2))
    return
  }
  printConnection(site.siteUrl, data)
}

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Check a Site\'s hosted IndexNow connection and Automatic sending state (hosted)',
  },
  args: {
    target: { type: 'positional', required: false, description: 'Site URL or Site ID (or pass --site)' },
    ...HOSTED_ARGS,
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    await runIndexNowStatus(args as Record<string, unknown>, args.target ? String(args.target) : undefined)
  },
})

const submitCommand = defineCommand({
  meta: {
    name: 'submit',
    description: 'Send URLs to IndexNow through gscdump and return the Submission Receipt (hosted)',
  },
  args: {
    'urls': { type: 'positional', required: false, description: 'URLs to notify (or `<site> <urls...>`, `--file`, or stdin)' },
    ...HOSTED_ARGS,
    'file': { type: 'string', alias: 'f', description: 'File with URLs (one per line)' },
    'idempotency-key': { type: 'string', description: 'Idempotency key (defaults to a generated UUID)' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const rawPositionals = ((args._ as string[] | undefined) ?? []).map(String)
    let siteArg = args.site ? String(args.site) : undefined
    let urlPositionals = rawPositionals
    // Allow `<site> <url...>` when `--site` is omitted and the first positional is a Site identifier, not an HTTP(S) URL.
    if (!siteArg && rawPositionals.length > 0 && !/^https?:\/\//i.test(rawPositionals[0]!)) {
      siteArg = rawPositionals[0]
      urlPositionals = rawPositionals.slice(1)
    }

    const urls = await readUrlList({ file: args.file, positionals: urlPositionals })
    if (urls.length === 0)
      throw commandLineError('No URLs provided. Pass URLs as arguments, --file, or stdin.')
    if (urls.length > MAX_INDEXNOW_URLS)
      throw commandLineError(`IndexNow accepts at most ${MAX_INDEXNOW_URLS} URLs per submission; received ${urls.length}.`)
    const invalid = urls.find(url => !URL.canParse(url))
    if (invalid)
      throw commandLineError(`Not an absolute URL: ${invalid}. Pass full URLs such as https://example.com/guide.`)

    const idempotencyKey = args['idempotency-key'] ? String(args['idempotency-key']).trim() : crypto.randomUUID()
    if (!idempotencyKey)
      throw commandLineError('--idempotency-key cannot be empty.')

    const { client, site } = await resolveHostedSite(
      { ...args, ...(siteArg ? { site: siteArg } : {}), _: [] },
      { name: 'indexing indexnow submit', localAlternative: LOCAL_ALTERNATIVE },
    )
    const { data } = await client.submitSiteIndexNow({
      params: { siteId: site.siteId },
      body: { urls, idempotencyKey },
    })
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    printReceipt(data.submissionReceipt)
  },
})

const receiptsCommand = defineCommand({
  meta: {
    name: 'receipts',
    description: 'List recent IndexNow Submission Receipts for a Site (hosted)',
  },
  args: {
    target: { type: 'positional', required: false, description: 'Site URL or Site ID (or pass --site)' },
    ...HOSTED_ARGS,
    limit: { type: 'string', alias: 'l', description: 'Max receipts to return (1 to 100)' },
    offset: { type: 'string', description: 'Pagination offset' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const limit = parseIntegerOption(args.limit, '--limit')
    const offset = parseIntegerOption(args.offset, '--offset', 0)
    const { client, site } = await resolveHostedSiteWithTarget(
      args as Record<string, unknown>,
      { name: 'indexing indexnow receipts', localAlternative: LOCAL_ALTERNATIVE },
      args.target ? String(args.target) : undefined,
    )
    const { data } = await client.listSiteIndexNowSubmissionReceipts({
      params: { siteId: site.siteId },
      query: {
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      },
    })
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    if (data.submissionReceipts.length === 0) {
      logger.info(`No IndexNow Submission Receipts recorded for ${site.siteUrl}.`)
      return
    }
    for (const line of renderTable(
      data.submissionReceipts.map(r => ({
        id: r.id,
        state: r._tag,
        trigger: r.trigger,
        urls: r.urls.length,
        httpStatus: r.httpStatus ?? '',
        createdAt: r.createdAt.slice(0, 19).replace('T', ' '),
      })),
      [
        { key: 'id', label: 'Receipt ID' },
        { key: 'state', label: 'State' },
        { key: 'trigger', label: 'Trigger' },
        { key: 'urls', label: 'URLs', numeric: true },
        { key: 'httpStatus', label: 'HTTP', numeric: true },
        { key: 'createdAt', label: 'Created (UTC)' },
      ],
      terminalOutputOptions(),
    )) {
      console.log(line)
    }
  },
})

const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description: 'Verify the hosted IndexNow key file for a Site (hosted)',
  },
  args: {
    target: { type: 'positional', required: false, description: 'Site URL or Site ID (or pass --site)' },
    ...HOSTED_ARGS,
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { client, site } = await resolveHostedSiteWithTarget(
      args as Record<string, unknown>,
      { name: 'indexing indexnow verify', localAlternative: LOCAL_ALTERNATIVE },
      args.target ? String(args.target) : undefined,
    )
    const { data } = await client.verifySiteIndexNowConnection({ params: { siteId: site.siteId } })
    if (json) {
      console.log(JSON.stringify({ siteId: site.siteId, siteUrl: site.siteUrl, connection: data }, null, 2))
      return
    }
    printConnection(site.siteUrl, data)
  },
})

export const indexingIndexNowCommand = defineCommand({
  meta: {
    name: 'indexnow',
    description: 'Inspect IndexNow connection status, verify the key file, or submit URLs (hosted)',
  },
  args: {
    ...HOSTED_ARGS,
    ...OUTPUT_ARGS,
  },
  subCommands: {
    status: statusCommand,
    submit: submitCommand,
    receipts: receiptsCommand,
    verify: verifyCommand,
  },
  async run({ args }) {
    await runIndexNowStatus(args as Record<string, unknown>)
  },
})
