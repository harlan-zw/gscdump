import type { BingEvidenceError, BingProviderError, BingWebmasterClient } from 'gscdump/bing'
import type { Result } from 'gscdump/result'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { toCSV } from './utils'

export const BING_DATASETS = ['traffic', 'pages', 'keywords', 'crawl', 'crawl-issues'] as const
type Dataset = typeof BING_DATASETS[number]
const datedDatasets = BING_DATASETS.filter(dataset => dataset !== 'crawl-issues')

const dateSchema = z.iso.date()
const dumpSchema = z.object({
  format: z.enum(['json', 'ndjson', 'csv']).default('json'),
  datasets: z.array(z.enum(BING_DATASETS)).min(1),
  start: dateSchema.optional(),
  end: dateSchema.optional(),
}).refine(value => !value.start || !value.end || value.start <= value.end, { message: '--start must precede --end' })

export type BingDumpOptions = z.infer<typeof dumpSchema> & {
  /** False when the caller took the default dataset list. */
  datasetsExplicit: boolean
}

// Crawl issues have no dates, so the default list includes them only when no date range is set.
export function parseBingDumpOptions(args: { format?: string, datasets?: string, start?: string, end?: string }): BingDumpOptions {
  const defaults = args.start || args.end ? datedDatasets : [...BING_DATASETS]
  const parsed = dumpSchema.safeParse({
    ...args,
    datasets: args.datasets ? [...new Set(args.datasets.split(',').map(value => value.trim()))] : defaults,
  })
  if (!parsed.success)
    throw new Error(`Invalid Bing dump options: ${parsed.error.issues.map(issue => issue.message).join('; ')}.`)
  if (parsed.data.datasets.includes('crawl-issues') && (parsed.data.start || parsed.data.end))
    throw new Error('Bing crawl issues have no dates. Export them without --start or --end.')
  return { ...parsed.data, datasetsExplicit: Boolean(args.datasets) }
}

export function unwrapBing<T>(result: Result<T, BingProviderError | BingEvidenceError>): T {
  if (result.ok)
    return result.value
  const error = result.error
  const help = error._tag === 'AuthenticationRequired'
    ? ' Run `gscdump bing login` again.'
    : error._tag === 'Throttled' && error.retryAfterMs !== undefined
      ? ` Retry after ${Math.ceil(error.retryAfterMs / 1000)} seconds.`
      : ''
  throw new Error(`Bing request failed: ${error._tag}.${help}`)
}

function siteIdentity(value: string): string {
  const url = URL.parse(value)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use the full Bing site URL from `gscdump bing sites`.')
  return url.toString()
}

export async function resolveBingSites(client: BingWebmasterClient, input: { site?: string, allSites?: boolean }): Promise<string[]> {
  if (Boolean(input.site) === Boolean(input.allSites))
    throw new Error('Choose --site URL or --all-sites.')
  const wanted = input.site ? siteIdentity(input.site) : null
  const sites = unwrapBing(await client.getUserSites({ signal: AbortSignal.timeout(30_000) }))
  const verified = sites.filter(site => site.isVerified)
  if (input.allSites) {
    const unique = new Map(verified.map(site => [siteIdentity(site.url), site.url]))
    if (unique.size === 0)
      throw new Error('No verified Bing sites are available.')
    return [...unique.values()]
  }
  const match = verified.find(site => siteIdentity(site.url) === wanted)
  if (!match)
    throw new Error('The Bing site is missing or unverified. Run `gscdump bing sites` and verify the site.')
  return [match.url]
}

const columns: Record<Dataset, string[]> = {
  'traffic': ['date', 'clicks', 'impressions'],
  'pages': ['date', 'page', 'clicks', 'impressions', 'averageClickPosition', 'averageImpressionPosition'],
  'keywords': ['date', 'query', 'clicks', 'impressions', 'averageClickPosition', 'averageImpressionPosition'],
  'crawl': ['date', 'crawledPages', 'inIndex', 'inLinks', 'crawlErrors', 'blockedByRobotsTxt', 'containsMalware', 'code2xx', 'code301', 'code302', 'code4xx', 'code5xx', 'allOtherCodes', 'connectionTimeout', 'dnsFailures'],
  'crawl-issues': ['url', 'httpCode', 'inLinks', 'issue', 'rawIssueCode'],
}

export async function dumpBingSite(
  client: BingWebmasterClient,
  siteUrl: string,
  outDir: string,
  options: BingDumpOptions,
): Promise<BingDumpSummary> {
  const calls = {
    'traffic': client.getRankAndTrafficStats,
    'pages': client.getPageStats,
    'keywords': client.getQueryStats,
    'crawl': client.getCrawlStats,
    'crawl-issues': client.getCrawlIssues,
  }
  const results = await Promise.all(options.datasets.map(async (dataset) => {
    // Complete every requested read before replacing any files from an earlier dump.
    const result = await calls[dataset](siteUrl, { signal: AbortSignal.timeout(30_000) })
    const rows = unwrapBing<Array<object>>(result).filter((row) => {
      if (!('date' in row) || typeof row.date !== 'string')
        return true
      const date = row.date.slice(0, 10)
      return (!options.start || date >= options.start) && (!options.end || date <= options.end)
    })
    return { dataset, rows }
  }))
  return writeBingDump(siteUrl, outDir, options.format, results)
}

export interface BingDumpDataset {
  dataset: Dataset
  rows: object[]
  sync?: object
  semantics?: string
}

export interface BingDumpSummary {
  searchEngine: 'bing'
  siteUrl: string
  observedAt: string
  format: 'json' | 'ndjson' | 'csv'
  files: Array<{ dataset: Dataset, rows: number, path: string, sync?: object, semantics?: string }>
}

export async function writeBingDump(siteUrl: string, outDir: string, format: 'json' | 'ndjson' | 'csv', results: BingDumpDataset[]): Promise<BingDumpSummary> {
  const siteDir = path.resolve(outDir, encodeURIComponent(siteUrl))
  await fs.mkdir(siteDir, { recursive: true })
  const staging = await fs.mkdtemp(path.join(siteDir, '.dump-'))
  try {
    const files = []
    for (const { dataset, rows, sync, semantics } of results) {
      const name = `${dataset}.${format}`
      const body = format === 'json'
        ? `${JSON.stringify(rows, null, 2)}\n`
        : format === 'ndjson'
          ? rows.map(row => `${JSON.stringify(row)}\n`).join('')
          : `${toCSV(rows, columns[dataset])}\n`
      await fs.writeFile(path.join(staging, name), body)
      files.push({ dataset, rows: rows.length, path: path.join(siteDir, name), ...(sync ? { sync } : {}), ...(semantics ? { semantics } : {}) })
    }
    const summary = { searchEngine: 'bing' as const, siteUrl, observedAt: new Date().toISOString(), format, files }
    await fs.writeFile(path.join(staging, 'metadata.json'), `${JSON.stringify(summary, null, 2)}\n`)
    for (const file of files)
      await fs.rename(path.join(staging, path.basename(file.path)), file.path)
    await fs.rename(path.join(staging, 'metadata.json'), path.join(siteDir, 'metadata.json'))
    return summary
  }
  finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}
