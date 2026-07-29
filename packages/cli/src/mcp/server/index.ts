import type { Auth, VerificationMethod } from 'gscdump'
import type { HandlerContext } from '../types'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  addSite,
  deleteSite,
  getIndexingMetadata,
  getVerificationToken,
  getVerifiedSite,
  googleSearchConsole,
  listVerifiedSites,
  runSequentialBatch,
  unverifySite,
  verifySite,
} from 'gscdump'
import { z } from 'zod'
import { discoverLiveSitemap } from '../../sitemap'
import * as handlers from '../handlers'
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
} from '../types'

export interface CreateGscMcpServerOptions {
  name?: string
  version?: string
  getAuth: () => Promise<Auth> | Auth
}

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
  const { name = 'gscdump', version = '1.0.0', getAuth } = options

  const server = new McpServer({ name, version })

  const auth = async (): Promise<Auth> => Promise.resolve(getAuth())

  const getContext = async (): Promise<HandlerContext> => {
    const a = await auth()
    return {
      auth: a,
      client: googleSearchConsole(a),
    }
  }

  const getClient = async (): Promise<ReturnType<typeof googleSearchConsole>> => googleSearchConsole(await auth())

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
      const result = await handlers.listSitesWithSitemaps(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'list-sitemaps',
    {
      description: 'List sitemaps for a specific site',
      inputSchema: listSitemapsInput.shape,
    },
    async (args) => {
      const client = await getClient()
      const sitemaps = await client.sitemaps.list(args.siteUrl as string)
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
      const result = await handlers.getSitemap(args, await getContext())
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.registerTool(
    'submit-sitemap',
    {
      description: 'Submit a sitemap to Google Search Console',
      inputSchema: sitemapInput.shape,
    },
    async (args) => {
      const client = await getClient()
      await client.sitemaps.submit(args.siteUrl as string, args.feedpath as string)
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] }
    },
  )

  server.registerTool(
    'delete-sitemap',
    {
      description: 'Delete a sitemap from Google Search Console',
      inputSchema: sitemapInput.shape,
    },
    async (args) => {
      const client = await getClient()
      await client.sitemaps.delete(args.siteUrl as string, args.feedpath as string)
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] }
    },
  )

  server.registerTool(
    'list-reports',
    {
      description: 'List available reports (intent-keyed analyzer compositions). Returns id, description, default period/comparison, and per-report argsSpec.',
      inputSchema: listReportsInput.shape,
    },
    async () => {
      const result = handlers.listReports()
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
      const result = await handlers.runReportHandler(args, await getContext())
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
    groupType: z.enum(['and']).optional().describe('Always "and"; multiple groups are OR-ed together'),
    filters: z.array(dimensionFilterSchema),
  })

  server.registerTool(
    'query',
    {
      description: 'Run a custom search analytics query. Supports dimension filters (regex/contains/equals) via dimensionFilterGroups; multiple groups are OR-ed.',
      inputSchema: z.object({
        siteUrl: z.string().describe('GSC property URL (e.g., sc-domain:example.com)'),
        startDate: z.string().describe('Start date (YYYY-MM-DD)'),
        endDate: z.string().describe('End date (YYYY-MM-DD)'),
        dimensions: z.array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance'])).describe('Dimensions to group by'),
        rowLimit: z.number().optional().describe('Max rows (default 25000)'),
        type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional().describe('Search type'),
        dataState: z.enum(['final', 'all']).optional().describe('Data state: final (settled) or all (includes fresh)'),
        aggregationType: z.enum(['byPage', 'byProperty']).optional().describe('Aggregation type'),
        dimensionFilterGroups: z.array(filterGroupSchema).optional().describe('Filter groups (each "and"-ed internally; multiple groups are OR-ed)'),
      }).shape,
    },
    async ({ siteUrl, startDate, endDate, dimensions, rowLimit, type, dataState, aggregationType, dimensionFilterGroups }) => {
      const client = await getClient()
      const result = await runMcpSearchAnalyticsQuery(client, {
        siteUrl: siteUrl as string,
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
    async (args) => {
      const client = await getClient()
      const result = await client.inspect(args.siteUrl as string, args.inspectionUrl as string)
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
      const result = await handlers.requestIndexing(args, await getContext())
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
      const result = await handlers.getIndexingStatus(args, await getContext())
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
      const result = await handlers.batchRequestIndexing(args, await getContext())
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
      const result = await handlers.batchInspectUrls(args, await getContext())
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
      const result = await handlers.diagnostics(args, await getContext())
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
