import { isGscdumpV1Error } from '@gscdump/sdk/v1'
import { defineCommand } from 'citty'
import { HOSTED_ARGS, resolveHostedSite } from '../hosted-site'
import { commandLineError, stopError } from '../stop'
import { applyOutputMode, logger, OUTPUT_ARGS, readUrlList } from '../utils'

export const indexingInspectCommand = defineCommand({
  meta: { name: 'inspect', description: 'Refresh Google URL Inspection results through gscdump.com (hosted; spends URL Inspections)' },
  args: {
    ...HOSTED_ARGS,
    ...OUTPUT_ARGS,
    urls: { type: 'positional', required: false, description: 'Up to 10 URLs on the Site host' },
    file: { type: 'string', alias: 'f', description: 'File with URLs (one per line), or use stdin' },
    yes: { type: 'boolean', alias: 'y', default: false, description: 'Allow this request to spend URL Inspections' },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    if (!args.yes)
      throw commandLineError('This request spends URL Inspections. Pass --yes to proceed.')
    const urls = [...new Set(await readUrlList({ file: args.file, positionals: args._ }))]
    if (urls.length === 0 || urls.length > 10)
      throw commandLineError('Pass 1 to 10 URLs. This command sends one request and does not split batches.')
    for (const value of urls) {
      const url = URL.parse(value)
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
        throw commandLineError(`Invalid URL: ${value}. Pass an HTTP URL without credentials or a fragment.`)
    }
    const { client, site } = await resolveHostedSite({ ...args, _: [] }, {
      name: 'indexing inspect',
      localAlternative: 'run `gscdump inspect --site <site> <url...>`',
    })
    // The v1 operation forbids retries because every request can spend quota.
    const { data } = await client.inspectSiteUrls({ params: { siteId: site.siteId }, body: { urls } }).catch((error: unknown) => {
      if (!isGscdumpV1Error(error) || error.code !== 'rate_limited')
        throw error
      const seconds = error.details.retryAfterSeconds
      const wait = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? ` Wait ${Math.ceil(seconds)} seconds before trying again.`
        : ' Wait for the quota reset before trying again.'
      throw stopError({ code: 'QUOTA_USED_UP', message: `${error.message}${wait}`, nextCommand: null })
    })
    if (json) {
      console.log(JSON.stringify(data, null, 2))
    }
    else {
      for (const result of data.results)
        console.log(`${result.url}: ${result.coverageState ?? result.verdict ?? 'unknown'}`)
      for (const error of data.errors)
        console.log(`${error.url}: ${error.error}`)
      for (const skipped of data.skipped)
        console.log(`${skipped.url}: skipped (${skipped.reason})`)
      logger.info(`${data.rateLimit.remaining} of ${data.rateLimit.limit} daily URL Inspections remain.`)
    }
    if (data.errors.length || data.skipped.length)
      throw new Error('Some URLs were not inspected. Read the errors and skipped URLs before trying again.')
  },
})
