import type { $Fetch } from 'ofetch'
import type { GSCQueryBuilder } from '../query/builder'
import type { Dimension, GSCRow } from '../query/types'
import type { CallOptions, GoogleSearchConsoleClient } from './client'
import type { ApiSite, ApiSitemap, SearchAnalyticsQuery } from './types'
import { ofetch } from 'ofetch'
import { resolveToBody } from '../query/resolver'
import { rowWithMetricDefaults } from './cli-format'

export interface GscdumpApiOptions {
  /** API key (gsd_user_xxx or gsd_prod_xxx) */
  apiKey: string
  /** Base URL (defaults to https://gscdump.com) */
  baseUrl?: string
}

interface ApiQueryResponse {
  rows: Array<Record<string, unknown> & {
    clicks: number
    impressions: number
    ctr: number
    position: number
  }>
  meta: {
    siteUrl: string
    dimensions: string[]
    dateRange: { startDate: string, endDate: string }
    rowCount: number
    hasMore: boolean
  }
  metadata?: {
    first_incomplete_date?: string
    first_incomplete_hour?: string
  }
}

interface ApiSitesResponse {
  sites: Array<{
    id: string
    gscSiteUrl: string
    displayName: string
    permissionLevel?: string
  }>
}

/**
 * Create a client that queries GSC data through gscdump.com API
 * instead of directly to Google. Useful when you don't have OAuth credentials.
 *
 * @example
 * ```ts
 * const client = gscdumpApi({ apiKey: 'gsd_user_xxx' })
 *
 * // Same query builder usage as direct client
 * for await (const rows of client.query(siteId, gsc.select('page', 'query').where(...))) {
 *   console.log(rows)
 * }
 * ```
 */
const TRAILING_SLASH_RE = /\/$/

export function gscdumpApi(options: GscdumpApiOptions): GoogleSearchConsoleClient {
  const baseUrl = options.baseUrl?.replace(TRAILING_SLASH_RE, '') || 'https://gscdump.com'

  const fetch: $Fetch = ofetch.create({
    baseURL: baseUrl,
    retry: 3,
    retryDelay: 1000,
    retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
    headers: {
      'x-api-key': options.apiKey,
      'Content-Type': 'application/json',
    },
  })

  const rawQuery = async (siteId: string, body: SearchAnalyticsQuery, opts?: CallOptions): Promise<{ rows: Array<{ keys: string[], clicks: number, impressions: number, ctr: number, position: number }> }> => {
    const response = await fetch<ApiQueryResponse>(`/api/sites/${encodeURIComponent(siteId)}/query`, {
      method: 'POST',
      body,
      signal: opts?.signal,
    })

    // Transform to GSC API format
    return {
      rows: response.rows.map((row) => {
        const keys = response.meta.dimensions.map(dim => String(row[dim] ?? ''))
        return {
          keys,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        }
      }),
    }
  }

  return {
    async* query<D extends Dimension[], C>(siteId: string, builder: GSCQueryBuilder<D, C>, opts?: CallOptions) {
      const state = builder.getState()
      const body = resolveToBody(state)
      const totalCap = body.rowLimit
      const pageSize = Math.min(totalCap ?? 25_000, 25_000)
      let startRow = body.startRow || 0
      let yielded = 0
      let metadata: ApiQueryResponse['metadata']

      while (true) {
        opts?.signal?.throwIfAborted()
        const remaining = totalCap ? totalCap - yielded : pageSize
        if (remaining <= 0)
          break
        const rowLimit = Math.min(pageSize, remaining)
        const response = await fetch<ApiQueryResponse>(`/api/sites/${encodeURIComponent(siteId)}/query`, {
          method: 'POST',
          body: { ...body, startRow, rowLimit },
          signal: opts?.signal,
        })

        if (response.metadata)
          metadata = response.metadata

        const rows = response.rows.map((row) => {
          const result: any = rowWithMetricDefaults(row)
          state.dimensions.forEach((dim) => {
            result[dim] = row[dim]
          })
          return result as GSCRow<D, C>
        })

        yield rows
        yielded += rows.length

        if (!response.meta.hasMore || rows.length < rowLimit)
          break
        startRow += rows.length
      }
      return { metadata }
    },

    sites: (() => {
      const list = async (opts?: CallOptions): Promise<ApiSite[]> => {
        const response = await fetch<ApiSitesResponse>('/api/sites', { signal: opts?.signal })
        return response.sites.map(s => ({
          siteUrl: s.gscSiteUrl,
          permissionLevel: s.permissionLevel || 'siteOwner',
        })) as ApiSite[]
      }
      const unsupported = (op: string) => () => {
        throw new Error(`sites.${op} not available via gscdump API. Use googleSearchConsole() with OAuth credentials.`)
      }
      return Object.assign(list, {
        list,
        get: unsupported('get'),
        add: unsupported('add'),
        delete: unsupported('delete'),
      })
    })(),

    verification: {
      getToken: () => { throw new Error('Site Verification API not available via gscdump API. Use googleSearchConsole() with OAuth credentials.') },
      insert: () => { throw new Error('Site Verification API not available via gscdump API. Use googleSearchConsole() with OAuth credentials.') },
      list: () => { throw new Error('Site Verification API not available via gscdump API. Use googleSearchConsole() with OAuth credentials.') },
      get: () => { throw new Error('Site Verification API not available via gscdump API. Use googleSearchConsole() with OAuth credentials.') },
      delete: () => { throw new Error('Site Verification API not available via gscdump API. Use googleSearchConsole() with OAuth credentials.') },
    },

    // These operations aren't supported via API yet - throw helpful errors
    inspect: () => {
      throw new Error('URL inspection not available via gscdump API. Use googleSearchConsole() with OAuth credentials.')
    },

    sitemaps: {
      list: async (siteId, opts) => {
        const response = await fetch<{ sitemaps: ApiSitemap[] }>(`/api/sites/${encodeURIComponent(siteId)}/sitemaps`, { signal: opts?.signal })
        return response.sitemaps || []
      },
      get: () => {
        throw new Error('Sitemap get not available via gscdump API.')
      },
      submit: () => {
        throw new Error('Sitemap submit not available via gscdump API.')
      },
      delete: () => {
        throw new Error('Sitemap delete not available via gscdump API.')
      },
    },

    indexing: {
      publish: () => {
        throw new Error('Indexing API not available via gscdump API. Use googleSearchConsole() with OAuth credentials.')
      },
      getMetadata: () => {
        throw new Error('Indexing API not available via gscdump API. Use googleSearchConsole() with OAuth credentials.')
      },
    },

    _rawQuery: rawQuery as GoogleSearchConsoleClient['_rawQuery'],
  }
}
