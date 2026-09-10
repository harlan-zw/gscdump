import type { GscdumpV1Client, GscdumpV1OperationResponse } from '@gscdump/sdk/v1'
import type { CloudAuthentication } from './auth-state'
import type { BingDumpDataset, BingDumpSummary, parseBingDumpOptions } from './bing-data'
import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { getCloudAccount } from './auth-state'
import { writeBingDump } from './bing-data'

interface HostedBingSite {
  siteId: string
  siteUrl: string
  connection: GscdumpV1OperationResponse<'partner.sites.indexing.bing.connection.get'>['data']
}

export function hostedBingClient(state: CloudAuthentication): GscdumpV1Client {
  return createGscdumpV1Client({ apiRoot: state.apiRoot, credential: state.apiKey })
}

export async function listHostedBingSites(state: CloudAuthentication): Promise<HostedBingSite[]> {
  const account = await getCloudAccount(state)
  return loadHostedBingConnections(state, account.sites)
}

async function loadHostedBingConnections(state: CloudAuthentication, sites: { siteId: string, siteUrl: string }[]): Promise<HostedBingSite[]> {
  const client = hostedBingClient(state)
  return Promise.all(sites.map(async site => ({
    siteId: site.siteId,
    siteUrl: site.siteUrl,
    connection: (await client.getSiteBingConnection({ params: { siteId: site.siteId } }, { signal: AbortSignal.timeout(30_000) })).data,
  })))
}

export async function resolveHostedBingSites(state: CloudAuthentication, input: { site?: string, allSites?: boolean, requireConnected?: boolean }): Promise<HostedBingSite[]> {
  if (Boolean(input.site) === Boolean(input.allSites))
    throw new Error('Choose --site or --all-sites.')
  const account = await getCloudAccount(state)
  const exact = account.sites.filter(site => site.siteId === input.site || site.siteUrl === input.site)
  const normalize = (value: string): string | undefined => URL.parse(value.startsWith('sc-domain:') ? `https://${value.slice(10)}/` : value)?.toString()
  const requested = input.allSites
    ? account.sites
    : exact.length ? exact : account.sites.filter(site => normalize(site.siteUrl) === normalize(input.site!) && normalize(input.site!) !== undefined)
  if (requested.length === 0)
    throw new Error('No matching Bing site. Run `gscdump bing sites`.')
  if (!input.allSites && requested.length > 1)
    throw new Error('Multiple Bing sites match. Use a site ID from `gscdump bing sites`.')
  const connections = await loadHostedBingConnections(state, requested)
  const selected = input.allSites ? connections.filter(site => site.connection._tag === 'connected') : connections
  if (selected.length === 0)
    throw new Error('No matching Bing site. Run `gscdump bing sites`.')
  if (input.requireConnected !== false && selected.some(site => site.connection._tag !== 'connected'))
    throw new Error('Bing is not connected. Run `gscdump bing login --site SITE_ID`.')
  return selected
}

export async function dumpHostedBingSite(
  state: CloudAuthentication,
  site: { siteId: string, siteUrl: string },
  outDir: string,
  options: ReturnType<typeof parseBingDumpOptions>,
): Promise<BingDumpSummary> {
  if (options.datasets.includes('crawl-issues'))
    throw new Error('Bing crawl issues require local authentication. Use --mode local.')
  const endDate = options.end ?? new Date().toISOString().slice(0, 10)
  const startDate = options.start ?? new Date(Date.parse(endDate) - 366 * 86_400_000).toISOString().slice(0, 10)
  if (Date.parse(endDate) - Date.parse(startDate) > 366 * 86_400_000)
    throw new Error('Hosted Bing exports support at most 366 days. Use a shorter --start and --end range.')
  const client = hostedBingClient(state)
  const results: BingDumpDataset[] = []
  let remoteSiteUrl: string | undefined
  for (const dataset of options.datasets) {
    if (dataset === 'crawl-issues')
      continue
    let offset = 0
    let first: { observedAt: string, total: number } | undefined
    const rows: object[] = []
    while (true) {
      if (offset > 100_000)
        throw new Error('Bing pagination reached the API limit. Export a shorter date range.')
      const { data } = await client.getSiteBingData({
        params: { siteId: site.siteId },
        query: { dataset, startDate, endDate, limit: 500, offset },
      }, { signal: AbortSignal.timeout(30_000) })
      if (data.dataset !== dataset)
        throw new Error('The hosted API returned a different Bing dataset.')
      if (data.sync._tag !== 'ready')
        throw new Error(`Bing ${dataset} data is ${data.sync._tag}. Retry after the hosted sync succeeds.`)
      if (remoteSiteUrl && data.siteUrl !== remoteSiteUrl)
        throw new Error('The Bing connection changed during export. Retry the dump.')
      remoteSiteUrl = data.siteUrl
      if (first && (data.sync.observedAt !== first.observedAt || data.pagination.total !== first.total))
        throw new Error('The Bing dataset changed during export. Retry the dump.')
      first ??= { observedAt: data.sync.observedAt, total: data.pagination.total }
      if (data.pagination.offset !== offset || (data.pagination.hasMore && data.rows.length === 0)
        || (data.pagination.hasMore ? offset + data.rows.length >= first.total : offset + data.rows.length !== first.total)) {
        throw new Error('The hosted API returned inconsistent Bing pagination. Retry the dump.')
      }
      rows.push(...(data.dataset === 'keywords'
        ? data.rows.map(({ keyword, ...row }) => ({ ...row, query: keyword }))
        : data.rows))
      if (!data.pagination.hasMore) {
        results.push({ dataset, rows, sync: data.sync, semantics: data.semantics })
        break
      }
      offset += data.rows.length
    }
  }
  return writeBingDump(remoteSiteUrl ?? site.siteUrl, outDir, options.format, results)
}

type HostedBingEvidence = GscdumpV1OperationResponse<'partner.sites.indexing.bing.evidence.list'>['data']['indexingEvidence'][number]

export async function inspectHostedBingUrl(state: CloudAuthentication, siteId: string, url: string): Promise<HostedBingEvidence | { _tag: 'unknown', searchEngine: 'bing', url: string, reason: 'not-observed', observedAt: null }> {
  const client = hostedBingClient(state)
  let offset = 0
  while (true) {
    const { data } = await client.listSiteBingIndexingEvidence({
      params: { siteId },
      query: { limit: 500, offset },
    }, { signal: AbortSignal.timeout(30_000) })
    const evidence = data.indexingEvidence.find(row => row.url === url)
    if (evidence)
      return evidence
    if (!data.pagination.hasMore)
      return { _tag: 'unknown', searchEngine: 'bing', url, reason: 'not-observed', observedAt: null }
    if (data.pagination.offset !== offset || data.indexingEvidence.length === 0)
      throw new Error('The hosted API returned inconsistent Bing evidence pagination.')
    offset += data.indexingEvidence.length
  }
}
