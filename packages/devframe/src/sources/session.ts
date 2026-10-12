// The browser extension's source: the dashboard's own routes, read with the
// gscdump.com login cookie. The extension holds no credential. Chrome attaches
// the cookie because the extension has host permission for gscdump.com.

import type { ArchetypeQuery } from '@gscdump/contracts/archetypes'
import type { BlockedContext, DateWindow, SiteSummary } from '../shared/protocol'
import type { RowsRead, SitesRead, StatsSource } from '../source'
import { parseRecordReadRefusal } from '@gscdump/contracts'
import { entityDailyTimeseries, topNBreakdown } from '@gscdump/contracts/archetypes'
import { z } from 'zod'
import { hostOf } from '../source'

export interface SessionSourceOptions {
  /** The gscdump.com origin. Defaults to `https://gscdump.com`. */
  origin?: string
  fetch?: typeof fetch
}

/** `GET /api/__gsc/sites`: the signed-in user's Sites, own and shared. */
const sitesSchema = z.array(z.object({
  id: z.string(),
  label: z.string(),
  hostname: z.string(),
  oldestDateSynced: z.string().nullable().optional(),
  newestDateSynced: z.string().nullable().optional(),
}).loose())

const archetypeResultSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
}).loose()

/** h3 errors carry their details in `data`. The record refusal is one of them. */
const errorBodySchema = z.object({
  message: z.string().optional(),
  data: z.unknown().optional(),
}).loose()

export function createSessionSource(options: SessionSourceOptions = {}): StatsSource {
  const origin = (options.origin ?? 'https://gscdump.com').replace(/\/+$/, '')
  const request = options.fetch ?? globalThis.fetch
  const signedOut: BlockedContext = { _tag: 'SignedOut', signInUrl: `${origin}/auth/google` }

  async function send(path: string, init: RequestInit = {}): Promise<Response | Error> {
    return request(`${origin}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
  }

  async function sites(): Promise<SitesRead> {
    const response = await send('/api/__gsc/sites')
    if (response instanceof Error)
      return { _tag: 'Blocked', context: { _tag: 'Unavailable', message: `gscdump.com did not answer: ${response.message}` } }
    if (response.status === 401 || response.status === 403)
      return { _tag: 'Blocked', context: signedOut }
    if (!response.ok)
      return { _tag: 'Blocked', context: { _tag: 'Unavailable', message: `gscdump.com answered ${response.status}.` } }
    const parsed = sitesSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success)
      return { _tag: 'Blocked', context: { _tag: 'Unavailable', message: 'gscdump.com returned Sites this version cannot read.' } }
    return {
      _tag: 'Ok',
      sites: parsed.data.map((site): SiteSummary => ({
        siteId: site.id,
        siteUrl: site.label,
        host: hostOf(site.hostname) ?? site.hostname,
        oldestDate: site.oldestDateSynced ?? null,
        newestDate: site.newestDateSynced ?? null,
      })),
    }
  }

  async function archetype(siteId: string, query: ArchetypeQuery): Promise<RowsRead> {
    const response = await send(`/api/sites/${encodeURIComponent(siteId)}/archetype-query`, { method: 'POST', body: JSON.stringify(query) })
    if (response instanceof Error)
      return { _tag: 'Failed', message: `gscdump.com did not answer: ${response.message}`, requestId: null }
    if (response.ok) {
      const parsed = archetypeResultSchema.safeParse(await response.json().catch(() => null))
      return parsed.success
        ? { _tag: 'Ok', rows: parsed.data.rows }
        : { _tag: 'Failed', message: 'gscdump.com returned rows this version cannot read.', requestId: null }
    }
    if (response.status === 401 || response.status === 403)
      return { _tag: 'Unauthorized', context: signedOut }
    if (response.status === 429)
      return { _tag: 'RateLimited' }
    const body = errorBodySchema.safeParse(await response.json().catch(() => null))
    const refusal = body.success ? parseRecordReadRefusal(body.data.data) : null
    if (refusal)
      return { _tag: 'Refused', refusal }
    return {
      _tag: 'Failed',
      message: (body.success && body.data.message) || `gscdump.com answered ${response.status}.`,
      requestId: response.headers.get('x-request-id'),
    }
  }

  return {
    sites,
    dailyRows: (siteId, path, window: DateWindow) =>
      archetype(siteId, entityDailyTimeseries(siteId, window, { dimension: 'page', value: path })),
    queryRows: (siteId, path, window: DateWindow, limit) =>
      archetype(siteId, topNBreakdown(siteId, window, 'query', {
        facets: [{ column: 'page', op: 'eq', value: path }],
        orderBy: { metric: 'clicks', dir: 'desc' },
        limit,
      })),
    dashboardOrigin: origin,
  }
}
