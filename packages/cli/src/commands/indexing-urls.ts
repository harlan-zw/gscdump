import type { GscdumpV1Client, GscdumpV1OperationResponse } from '@gscdump/sdk/v1'
import type { HostedSite } from '../hosted-site'
import { defineCommand } from 'citty'
import { HOSTED_ARGS, resolveHostedSite } from '../hosted-site'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { applyOutputMode, logger, parseIntegerOption, toCSV } from '../utils'

type IndexingUrlsPage = GscdumpV1OperationResponse<'partner.sites.indexing.urls.list'>['data']
type IndexingUrlRow = IndexingUrlsPage['urls'][number]

const STATUSES = ['indexed', 'not_indexed', 'pending'] as const
const FORMATS = ['table', 'json', 'csv'] as const
const MAX_PAGE_SIZE = 500
const CSV_COLUMNS = ['url', 'verdict', 'coverageState', 'issueType', 'lastCrawlTime', 'lastCheckedAt', 'googleCanonical', 'userCanonical', 'sitemaps'] as const

type Status = typeof STATUSES[number]
type Format = typeof FORMATS[number]

function parseChoice<T extends string>(value: unknown, flag: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === '')
    return undefined
  if (!allowed.includes(String(value) as T))
    throw new Error(`Invalid ${flag}: ${String(value)}. Use ${allowed.join(', ')}.`)
  return String(value) as T
}

async function fetchAllPages(client: GscdumpV1Client, site: HostedSite, query: { status?: Status, search?: string }): Promise<IndexingUrlsPage> {
  const urls: IndexingUrlRow[] = []
  let first: IndexingUrlsPage | undefined
  while (true) {
    const { data } = await client.listSiteIndexingUrls({
      params: { siteId: site.siteId },
      query: { ...query, limit: MAX_PAGE_SIZE, offset: urls.length },
    })
    first ??= data
    if (data.pagination.offset !== urls.length || (data.pagination.hasMore && data.urls.length === 0))
      throw new Error('The hosted API returned inconsistent indexing pagination. Run the command again.')
    urls.push(...data.urls)
    if (!data.pagination.hasMore)
      return { ...first, urls, pagination: { ...data.pagination, total: urls.length, limit: urls.length, offset: 0, hasMore: false } }
  }
}

function csvRow(row: IndexingUrlRow): Record<string, unknown> {
  return { ...row, sitemaps: (row.sitemaps ?? []).join(' ') }
}

export const indexingUrlsCommand = defineCommand({
  meta: {
    name: 'urls',
    description: 'List Google URL Inspection results for a Site\'s URLs, filtered by status (hosted)',
  },
  args: {
    ...HOSTED_ARGS,
    status: { type: 'string', description: `Filter by status: ${STATUSES.join(', ')}` },
    search: { type: 'string', description: 'Only URLs that contain this text' },
    limit: { type: 'string', alias: 'l', default: '100', description: `Rows per page, maximum ${MAX_PAGE_SIZE}` },
    offset: { type: 'string', default: '0', description: 'Rows to skip before the page' },
    all: { type: 'boolean', default: false, description: 'Read every page; ignores --limit and --offset' },
    format: { type: 'string', alias: 'f', default: 'table', description: `Output format: ${FORMATS.join(', ')}` },
    json: { type: 'boolean', default: false, description: 'Output as JSON (same as --format json)' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info output' },
  },
  async run({ args }) {
    const format: Format = args.json ? 'json' : parseChoice(args.format, '--format', FORMATS) ?? 'table'
    const status = parseChoice(args.status, '--status', STATUSES)
    const limit = parseIntegerOption(args.limit, '--limit') ?? 100
    const offset = parseIntegerOption(args.offset, '--offset', 0) ?? 0
    if (limit > MAX_PAGE_SIZE)
      throw new Error(`--limit must be ${MAX_PAGE_SIZE} or less. Use --all to read every page.`)
    const search = args.search ? String(args.search) : undefined
    applyOutputMode({ json: format !== 'table', quiet: args.quiet })
    const filters = { ...(status ? { status } : {}), ...(search ? { search } : {}) }

    const { client, site } = await resolveHostedSite(args, {
      name: 'indexing urls',
      localAlternative: 'pipe `gscdump sitemaps urls <sitemap-url>` into `gscdump entities inspect`',
    })
    const page = args.all
      ? await fetchAllPages(client, site, filters)
      : (await client.listSiteIndexingUrls({ params: { siteId: site.siteId }, query: { ...filters, limit, offset } })).data

    if (format === 'json') {
      console.log(JSON.stringify(page, null, 2))
      return
    }
    if (format === 'csv') {
      console.log(toCSV(page.urls.map(csvRow), [...CSV_COLUMNS]))
      return
    }

    const options = terminalOutputOptions()
    if (page.urls.length === 0) {
      logger.info(`No URLs${status ? ` with status ${status}` : ''} for ${site.siteUrl}.`)
      return
    }
    for (const line of renderTable(page.urls.map(row => ({
      url: row.url,
      coverage: row.coverageState ?? row.verdict ?? 'unknown',
      lastCrawl: row.lastCrawlTime?.slice(0, 10) ?? 'never',
      sitemaps: row.sitemaps?.length ?? 0,
    })), [
      { key: 'url', label: 'URL' },
      { key: 'coverage', label: 'Coverage' },
      { key: 'lastCrawl', label: 'Last crawl' },
      { key: 'sitemaps', label: 'Sitemaps', numeric: true },
    ], options)) {
      console.log(line)
    }
    const { total, offset: start, hasMore } = page.pagination
    logger.info(`Showing ${start + 1}-${start + page.urls.length} of ${total} URLs for ${site.siteUrl}.`)
    if (hasMore)
      logger.info(`For the next page, pass --offset ${start + page.urls.length}. To read every page, pass --all.`)
  },
})
