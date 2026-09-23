import type { SiteCandidate } from 'gscdump'
import type { Auth } from 'gscdump/client'
import type { VerificationMethod } from 'gscdump/sites'
import type { HandlerContext } from '../types'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { resolveSiteInput } from 'gscdump'
import { googleSearchConsole } from 'gscdump/client'
import {
  getIndexingMetadata,
  runSequentialBatch,
} from 'gscdump/indexing'
import { SearchTypes } from 'gscdump/query'
import {
  addSite,
  deleteSite,
  getVerificationToken,
  getVerifiedSite,
  listVerifiedSites,
  unverifySite,
  verifySite,
} from 'gscdump/sites'
import { z } from 'zod'
import { formatSiteResolution } from '../../context'
import { discoverLiveSitemap } from '../../sitemap'
import { diagnostics } from '../handlers/diagnostics'
import {
  batchInspectUrls,
  batchRequestIndexing,
  getIndexingStatus,
  requestIndexing,
} from '../handlers/indexing'
import { listReports, runReportHandler } from '../handlers/reports'
import { getSitemap, listSitesWithSitemaps } from '../handlers/sites'
import {
  batchInspectUrlsInput,
  batchRequestIndexingInput,
  getIndexingStatusInput,
  inspectUrlInput,
  listReportsInput,
  listSitemapsInput,
  listSitesInput,
  requestIndexingInput,
  runReportInput,
  sitemapInput,
  siteUrlSchema,
} from '../types'

export type CreateGscMcpServerOptions = {
  name?: string
  version?: string
} & ({
  getAuth: () => Promise<Auth> | Auth
  getContext?: never
} | {
  getContext: () => Promise<HandlerContext> | HandlerContext
  getAuth?: never
})

interface QueryToolArgs {
  siteUrl: string
  startDate: string
  endDate: string
  dimensions: string[]
  rowLimit?: number
  type?: string
  dataState?: string
  aggregationType?: string
  dimensionFilterGroups?: Array<{
    groupType?: string
    filters: Array<{ dimension: string, operator: string, expression: string }>
  }>
}

type SearchAnalyticsClient = Pick<ReturnType<typeof googleSearchConsole>, 'searchAnalytics'>

export async function runMcpSearchAnalyticsQuery(
  client: SearchAnalyticsClient,
  args: QueryToolArgs,
): Promise<{ siteUrl: string, rowCount: number, rows: Record<string, unknown>[] }> {
  const totalLimit = Math.max(0, args.rowLimit ?? 25000)
  const pageSize = Math.min(totalLimit, 25000)
  const allRows: Record<string, unknown>[] = []
  let startRow = 0

  while (allRows.length < totalLimit) {
    const remaining = totalLimit - allRows.length
    const currentLimit = Math.min(pageSize, remaining)
    if (currentLimit <= 0)
      break

    const response = await client.searchAnalytics.query(args.siteUrl, {
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: args.dimensions,
      rowLimit: currentLimit,
      startRow,
      ...(args.type ? { type: args.type } : {}),
      ...(args.dataState ? { dataState: args.dataState } : {}),
      ...(args.aggregationType ? { aggregationType: args.aggregationType } : {}),
      ...(args.dimensionFilterGroups
        ? {
            dimensionFilterGroups: args.dimensionFilterGroups.map(g => ({
              groupType: g.groupType ?? 'and',
              filters: g.filters,
            })),
          }
        : {}),
    } as any)
    const rows = (response.rows || []).map((row) => {
      const result: Record<string, unknown> = {
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      }
      args.dimensions.forEach((dim, i) => {
        result[dim] = row.keys?.[i]
      })
      return result
    })
    if (rows.length === 0)
      break
    allRows.push(...rows)
    startRow += rows.length
  }

  return { siteUrl: args.siteUrl, rowCount: allRows.length, rows: allRows }
}

export function createGscMcpServer(options: CreateGscMcpServerOptions): McpServer {
  const { name = 'gscdump', version = '1.0.0' } = options

  const server = new McpServer({ name, version })

  const getContext = async (): Promise<HandlerContext> => {
    if (options.getContext)
      return options.getContext()
    const a = await options.getAuth()
    return {
      auth: a,
      client: googleSearchConsole(a),
    }
  }

  const getClient = async (): Promise<ReturnType<typeof googleSearchConsole>> => (await getContext()).client

  // One Site list per server. `add-site` and `delete-site` clear it.
  let siteList: Promise<SiteCandidate[]> | undefined
  const loadSiteList = (): Promise<SiteCandidate[]> => {
    siteList ??= getClient()
      .then(client => client.sites())
      .then(raw => raw.flatMap(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser' ? [{ siteUrl: s.siteUrl }] : []))
      .catch((error: unknown) => {
        // Do not cache a failure; the next tool call asks again.
        siteList = undefined
        throw error
      })
    return siteList
  }
  // Agents pass Sites as people write them (`example.com`), not as GSC keys.
  const withSite = async <T extends { siteUrl: string }>(args: T): Promise<T> => {
    const resolution = resolveSiteInput(args.siteUrl, await loadSiteList())
    if (resolution.kind !== 'resolved')
      throw new Error(formatSiteResolution(resolution, 'account'))
    return { ...args, siteUrl: resolution.siteUrl }
  }

  server.registerTool(
    'list-sites',
    {
      description: 'List all Google Search Console sites visible to the authenticated user.',
      inputSchema: listSitesInput.shape,
    },
    async () => {
      const client = await getClient()
      const raw = await client.sites()
      const sites = raw
        .filter(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
        .map(s => ({ siteUrl: s.siteUrl!, permissionLevel: s.permissionLevel || 'unknown' }))
      return { content: [{ type: 'text', text: JSON.stringify(sites, null, 2) }] }
    },
  )

  server.registerTool(
    'list-sites-with-sitemaps',
    {
      description: 'List all GSC sites with their sitemaps',
      inputSchema: listSitesInput.shape,
    },
    async (args) => {
      const result = await listSitesWithSitemaps(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'list-sitemaps',
    {
      description: 'List sitemaps for a specific site',
      inputSchema: listSitemapsInput.shape,
    },
    async (input) => {
      const args = await withSite(input)
      const client = await getClient()
      const sitemaps = await client.sitemaps.list(args.siteUrl)
      return { content: [{ type: 'text', text: JSON.stringify(sitemaps, null, 2) }] }
    },
  )

  server.registerTool(
    'get-sitemap',
    {
      description: 'Get details for a specific sitemap',
      inputSchema: sitemapInput.shape,
    },
    async (args) => {
      const result = await getSitemap(await withSite(args), await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'submit-sitemap',
    {
      description: 'Submit a sitemap to Google Search Console',
      inputSchema: sitemapInput.shape,
    },
    async (input) => {
      const args = await withSite(input)
      const client = await getClient()
      await client.sitemaps.submit(args.siteUrl, args.feedpath)
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] }
    },
  )

  server.registerTool(
    'delete-sitemap',
    {
      description: 'Delete a sitemap from Google Search Console',
      inputSchema: sitemapInput.shape,
    },
    async (input) => {
      const args = await withSite(input)
      const client = await getClient()
      await client.sitemaps.delete(args.siteUrl, args.feedpath)
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] }
    },
  )

  server.registerTool(
    'list-reports',
    {
      description: 'List Reports supported by the live Google API. Returns defaults and argsSpec using run-report input names.',
      inputSchema: listReportsInput.shape,
    },
    async () => {
      const result = listReports()
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'run-report',
    {
      description: 'Run a report against the GSC API. Returns a structured ReportResult with bounded findings per section. See list-reports for ids.',
      inputSchema: runReportInput.shape,
    },
    async (args) => {
      const result = await runReportHandler(args, getContext, async siteUrl => (await withSite({ siteUrl })).siteUrl)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  const filterOperatorSchema = z.enum([
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'includingRegex',
    'excludingRegex',
  ])

  const dimensionFilterSchema = z.object({
    dimension: z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance']),
    operator: filterOperatorSchema,
    expression: z.string(),
  })

  const filterGroupSchema = z.object({
    groupType: z.enum(['and']).optional().describe('Only "and" is supported; multiple groups do not implement OR'),
    filters: z.array(dimensionFilterSchema),
  })

  server.registerTool(
    'query',
    {
      description: 'Run a custom search analytics query with dimension filters (regex/contains/equals). Multiple filter groups do not implement OR.',
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        startDate: z.string().describe('Start date (YYYY-MM-DD)'),
        endDate: z.string().describe('End date (YYYY-MM-DD)'),
        dimensions: z.array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance'])).describe('Dimensions to group by'),
        rowLimit: z.number().optional().describe('Max rows (default 25000)'),
        type: z.enum(SearchTypes).optional().describe('Search type'),
        dataState: z.enum(['final', 'all']).optional().describe('Data state: final (settled) or all (includes fresh)'),
        aggregationType: z.enum(['byPage', 'byProperty']).optional().describe('Aggregation type'),
        dimensionFilterGroups: z.array(filterGroupSchema).optional().describe('Filter groups use "and" internally. Multiple groups do not implement OR.'),
      }).shape,
    },
    async ({ siteUrl: input, startDate, endDate, dimensions, rowLimit, type, dataState, aggregationType, dimensionFilterGroups }) => {
      const { siteUrl } = await withSite({ siteUrl: input as string })
      const client = await getClient()
      const result = await runMcpSearchAnalyticsQuery(client, {
        siteUrl,
        startDate: startDate as string,
        endDate: endDate as string,
        dimensions: dimensions as string[],
        rowLimit: rowLimit as number | undefined,
        type: type as string | undefined,
        dataState: dataState as string | undefined,
        aggregationType: aggregationType as string | undefined,
        dimensionFilterGroups: dimensionFilterGroups as QueryToolArgs['dimensionFilterGroups'],
      })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'inspect-url',
    {
      description: 'Inspect a URL to check its indexing status in Google Search Console',
      inputSchema: inspectUrlInput.shape,
    },
    async (input) => {
      const args = await withSite(input)
      const client = await getClient()
      const result = await client.inspect(args.siteUrl, args.inspectionUrl)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'request-indexing',
    {
      description: 'Request Google to index or remove a URL via the Indexing API',
      inputSchema: requestIndexingInput.shape,
    },
    async (args) => {
      const result = await requestIndexing(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'get-indexing-status',
    {
      description: 'Get indexing status metadata for a URL',
      inputSchema: getIndexingStatusInput.shape,
    },
    async (args) => {
      const result = await getIndexingStatus(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'batch-request-indexing',
    {
      description: 'Batch request indexing for multiple URLs with rate limiting',
      inputSchema: batchRequestIndexingInput.shape,
    },
    async (args) => {
      const result = await batchRequestIndexing(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'batch-inspect-urls',
    {
      description: 'Batch inspect multiple URLs to check their indexing status',
      inputSchema: batchInspectUrlsInput.shape,
    },
    async (args) => {
      const result = await batchInspectUrls(await withSite(args), await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'diagnostics',
    {
      description: 'Run health checks on the active GSC connection: auth/scopes, time skew, API reachability, sites count.',
      inputSchema: listSitesInput.shape,
    },
    async (args) => {
      const result = await diagnostics(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'add-site',
    {
      description: 'Register a property in Search Console (unverified). Verify ownership separately.',
      inputSchema: z.object({ siteUrl: z.string().describe('Property URL (https://example.com/ or sc-domain:example.com)') }).shape,
    },
    async ({ siteUrl }) => {
      const client = await getClient()
      await addSite(client, siteUrl as string)
      siteList = undefined
      return { content: [{ type: 'text', text: JSON.stringify({ siteUrl, status: 'added', verified: false }, null, 2) }] }
    },
  )

  server.registerTool(
    'delete-site',
    {
      description: 'Remove a property from Search Console.',
      inputSchema: z.object({ siteUrl: z.string().describe('Property URL') }).shape,
    },
    async ({ siteUrl }) => {
      const client = await getClient()
      await deleteSite(client, siteUrl as string)
      siteList = undefined
      return { content: [{ type: 'text', text: JSON.stringify({ siteUrl, status: 'deleted' }, null, 2) }] }
    },
  )

  const verificationMethodSchema = z.enum(['META', 'FILE', 'DNS_TXT', 'DNS_CNAME', 'ANALYTICS', 'TAG_MANAGER'])

  server.registerTool(
    'get-verification-token',
    {
      description: 'Get a verification token to place on the site or in DNS.',
      inputSchema: z.object({
        siteUrl: z.string(),
        method: verificationMethodSchema,
      }).shape,
    },
    async ({ siteUrl, method }) => {
      const client = await getClient()
      const result = await getVerificationToken(client, siteUrl as string, method as VerificationMethod)
      return { content: [{ type: 'text', text: JSON.stringify({ siteUrl, method, token: result.token, site: result.site }, null, 2) }] }
    },
  )

  server.registerTool(
    'verify-site',
    {
      description: 'Trigger Google to validate a placed verification token.',
      inputSchema: z.object({
        siteUrl: z.string(),
        method: verificationMethodSchema,
      }).shape,
    },
    async ({ siteUrl, method }) => {
      const client = await getClient()
      const resource = await verifySite(client, siteUrl as string, method as VerificationMethod)
      return { content: [{ type: 'text', text: JSON.stringify({ siteUrl, method, resource }, null, 2) }] }
    },
  )

  server.registerTool(
    'list-verified-sites',
    {
      description: 'List verified WebResources from the Site Verification API.',
      inputSchema: z.object({}).shape,
    },
    async () => {
      const client = await getClient()
      const resources = await listVerifiedSites(client)
      return { content: [{ type: 'text', text: JSON.stringify(resources, null, 2) }] }
    },
  )

  server.registerTool(
    'get-verified-site',
    {
      description: 'Fetch a single verified WebResource by id.',
      inputSchema: z.object({ id: z.string().describe('WebResource id (from list-verified-sites)') }).shape,
    },
    async ({ id }) => {
      const client = await getClient()
      const resource = await getVerifiedSite(client, id as string)
      return { content: [{ type: 'text', text: JSON.stringify(resource, null, 2) }] }
    },
  )

  server.registerTool(
    'unverify-site',
    {
      description: 'Drop the calling user\'s verified ownership of a WebResource. Remove the placed token first or Google may re-verify.',
      inputSchema: z.object({ id: z.string().describe('WebResource id (from list-verified-sites)') }).shape,
    },
    async ({ id }) => {
      const client = await getClient()
      await unverifySite(client, id as string)
      return { content: [{ type: 'text', text: JSON.stringify({ id, status: 'unverified' }, null, 2) }] }
    },
  )

  server.registerTool(
    'discover-sitemap',
    {
      description: 'Probe a domain\'s robots.txt + common paths for an advertised sitemap (no auth).',
      inputSchema: z.object({ domain: z.string().describe('Domain (e.g., example.com)') }).shape,
    },
    async ({ domain }) => {
      const cleaned = String(domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      const discovery = await discoverLiveSitemap(cleaned)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            domain: cleaned,
            sitemap: discovery._tag === 'found' ? discovery.url : null,
            status: discovery._tag,
            ...(discovery._tag === 'incomplete' ? { failures: discovery.failures } : {}),
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'batch-get-indexing-status',
    {
      description: 'Get indexing notification metadata for multiple URLs.',
      inputSchema: z.object({
        urls: z.array(z.string()).describe('URLs'),
        delayMs: z.number().optional().describe('Delay between requests in ms (default 100)'),
        concurrency: z.number().optional().describe('Concurrent in-flight requests (default 1)'),
      }).shape,
    },
    async ({ urls, delayMs, concurrency }) => {
      const client = await getClient()
      const results = await runSequentialBatch(
        urls as string[],
        (url: string) => getIndexingMetadata(client, url),
        { delayMs: (delayMs as number | undefined) ?? 100, concurrency: (concurrency as number | undefined) ?? 1 },
      )
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
    },
  )

  return server
}

export { McpServer }
