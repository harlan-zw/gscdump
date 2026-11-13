import type { GenerativeAiImpressionsV1, GenerativeAiReportReadV1 } from '@gscdump/contracts/v1/http'
import type { HostedSite } from '../hosted-site'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseGenerativeAiReportExport } from '@gscdump/sdk/generative-ai-report'
import { defineCommand } from 'citty'
import { generativeAiCommandMeta } from '../command-meta'
import { generativeAiExportRefusal, generativeAiHostedStop, generativeAiSiteOf } from '../generative-ai'
import { generativeAiUploadSteps } from '../generative-ai-guidance'
import { HOSTED_ARGS, resolveHostedSite } from '../hosted-site'
import { stopError } from '../stop'
import { applyOutputMode, logger, OUTPUT_ARGS, plural } from '../utils'

const LOCAL_ALTERNATIVE = 'Generative AI report uploads are not available'
// The parser refuses a larger archive; checking first avoids reading a huge file into memory.
const MAX_EXPORT_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 30_000

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

function displayDate(isoDate: string): string {
  return DATE_FORMAT.format(new Date(isoDate.length === 10 ? `${isoDate}T00:00:00.000Z` : isoDate))
}

function displayImpressions(impressions: GenerativeAiImpressionsV1): string {
  return impressions._tag === 'reported' ? impressions.value.toLocaleString('en-US') : '-'
}

type GenerativeAiHostedSite = Awaited<ReturnType<typeof resolveHostedSite>> & {
  identity: ReturnType<typeof generativeAiSiteOf>
  call: <T>(request: Promise<T>) => Promise<T>
}

/** `args._` holds declared positionals too, so a command with one passes `_: []`. */
async function hostedSite(args: Record<string, unknown>, name: string): Promise<GenerativeAiHostedSite> {
  const resolved = await resolveHostedSite(args, { name: `generative-ai ${name}`, localAlternative: LOCAL_ALTERNATIVE })
  const identity = generativeAiSiteOf(resolved.site.siteUrl)
  /** Run one hosted call, and turn a failure this command can name into a stop. */
  const call = <T>(request: Promise<T>): Promise<T> => request.catch((error: unknown) => {
    const stop = generativeAiHostedStop(error, { apiRoot: resolved.authentication.apiRoot, siteId: resolved.site.siteId, registeredHost: identity.registeredHost })
    throw stop ? stopError(stop) : error
  })
  return { ...resolved, identity, call }
}

function printSteps(site: HostedSite): void {
  for (const line of generativeAiUploadSteps(site.siteId))
    console.log(line)
}

function printRead(read: GenerativeAiReportReadV1, site: HostedSite): void {
  if (read._tag === 'empty') {
    console.log(`No Generative AI report upload for ${site.siteUrl}.`)
    printSteps(site)
    return
  }
  console.log(`Data through ${displayDate(read.window.endDate)}. Uploaded ${displayDate(read.source.uploadedAt)}.`)
  if (read.freshness === 'stale')
    console.log('This data is more than 35 days old. Upload a newer export.')
  console.log('Page rows count each URL on this Site. Chart, country, and device rows count the whole Search Console property. So page rows can add up to more than the chart.')
  console.log('A dash means zero or unavailable. Google writes both as zero in the export.')
  if (read.pages.coverage._tag === 'truncated')
    console.log('Google exports 1,000 rows at most. This list can omit pages.')
  if (read.page) {
    console.log(read.page._tag === 'listed'
      ? `${read.page.url}: ${displayImpressions(read.page.impressions)} Generative AI impressions`
      : 'Not listed in this export.')
    return
  }
  console.log()
  for (const row of read.pages.rows)
    console.log(`  ${displayImpressions(row.impressions).padStart(7)}  ${row.url}`)
}

const uploadCommand = defineCommand({
  meta: { name: 'upload', description: 'Parse a Generative AI report export zip on this machine, then upload its rows for one Site' },
  args: {
    zip: { type: 'positional', required: true, description: 'Export zip from Search Console > Performance > Generative AI features > Export' },
    ...HOSTED_ARGS,
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { client, site, identity, call } = await hostedSite({ ...args, _: [] }, 'upload')
    const file = String(args.zip)
    const size = (await stat(file)).size
    if (size > MAX_EXPORT_BYTES)
      throw stopError(generativeAiExportRefusal({ _tag: 'file_too_large', scope: 'archive', file: null, limit: MAX_EXPORT_BYTES, found: size }))
    const parsed = await parseGenerativeAiReportExport({
      bytes: new Uint8Array(await readFile(file)),
      filename: path.basename(file),
      site: identity,
      now: new Date(),
    })
    if (!parsed.ok)
      throw stopError(generativeAiExportRefusal(parsed.error))
    const { data } = await call(client.createSiteGenerativeAiReportUpload(
      { params: { siteId: site.siteId }, body: parsed.value.upload },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    ))
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    logger.success(`${data.deduped ? 'This export was already uploaded' : 'Uploaded'} for ${site.siteUrl}: ${data.uploadId}, ${data.window.startDate} to ${data.window.endDate}.`)
    for (const warning of data.warnings) {
      logger.warn(warning._tag === 'filename_site_mismatch'
        ? `This filename names ${warning.prefix}, and you selected ${warning.host}. Check that you selected the correct Site.`
        : warning._tag === 'filename_unrecognized'
          ? `The filename ${warning.filename} does not match the Search Console export name.`
          : `No page row is on ${warning.host}, and Pages has 1,000 rows. The host can sit below the cutoff.`)
    }
    if (data.unmappedCountries.length)
      logger.warn(`No country code for: ${data.unmappedCountries.join(', ')}. Their rows keep the raw name.`)
  },
})

const listCommand = defineCommand({
  meta: { name: 'list', description: 'List Generative AI report uploads for one Site' },
  args: { ...HOSTED_ARGS, ...OUTPUT_ARGS },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { client, site, call } = await hostedSite(args, 'list')
    const { data } = await call(client.listSiteGenerativeAiReportUploads({ params: { siteId: site.siteId } }, { signal: AbortSignal.timeout(TIMEOUT_MS) }))
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    if (data.uploads.length === 0) {
      console.log(`No Generative AI report upload for ${site.siteUrl}.`)
      printSteps(site)
      return
    }
    logger.success(`${plural(data.uploads.length, 'upload', 'uploads')} for ${site.siteUrl}:`)
    for (const upload of data.uploads)
      console.log(`  ${upload.uploadId}  ${upload.window.startDate} to ${upload.window.endDate}  uploaded ${displayDate(upload.uploadedAt)}  ${upload.sourceFilename}`)
  },
})

const removeCommand = defineCommand({
  meta: { name: 'remove', description: 'Delete one Generative AI report upload, for example a wrong Site' },
  args: {
    uploadId: { type: 'positional', required: true, description: 'Upload id from `gscdump generative-ai list`' },
    ...HOSTED_ARGS,
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { client, site, call } = await hostedSite({ ...args, _: [] }, 'remove')
    const { data } = await call(client.removeSiteGenerativeAiReportUpload(
      { params: { siteId: site.siteId, uploadId: String(args.uploadId) } },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    ))
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    logger.success(`Removed ${data.uploadId} from ${site.siteUrl}.`)
  },
})

const showCommand = defineCommand({
  meta: { name: 'show', description: 'Read Generative AI impressions for one Site from its uploads' },
  args: {
    ...HOSTED_ARGS,
    'upload-id': { type: 'string', description: 'Read this upload. Defaults to the upload with the latest data end date' },
    'page-url': { type: 'string', description: 'Exact page URL to look up' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { client, site, call } = await hostedSite(args, 'show')
    const query = {
      ...(args['page-url'] ? { pageUrl: String(args['page-url']) } : {}),
      ...(args['upload-id'] ? { uploadId: String(args['upload-id']) } : {}),
    }
    const { data } = await call(client.getSiteGenerativeAiReport({ params: { siteId: site.siteId }, query }, { signal: AbortSignal.timeout(TIMEOUT_MS) }))
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    printRead(data, site)
  },
})

export const generativeAiCommand = defineCommand({
  meta: generativeAiCommandMeta,
  subCommands: { upload: uploadCommand, list: listCommand, remove: removeCommand, show: showCommand },
})
