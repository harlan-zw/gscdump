import type { $Fetch, FetchOptions } from 'ofetch'
import type { GSCQueryBuilder } from '../query/builder'
import type { Dimension, GSCRow } from '../query/types'
import type {
  ApiSite,
  ApiSitemap,
  InspectUrlIndexResponse,
  PublishUrlNotificationResponse,
  SearchAnalyticsQuery,
  SearchAnalyticsResponse,
  UrlNotificationMetadata,
} from './types'
import { ofetch } from 'ofetch'
import { resolveToBody } from '../query/resolver'

const GSC_API = 'https://searchconsole.googleapis.com'
const INDEXING_API = 'https://indexing.googleapis.com'

/**
 * Compatible interface with OAuth2Client from google-auth-library
 */
export interface AuthClient {
  credentials?: {
    access_token?: string | null
    refresh_token?: string | null
    expiry_date?: number | null
  }
  getAccessToken: () => Promise<{ token?: string | null }>
}

export interface AuthOptions {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export function createAuth(options: AuthOptions): AuthClient {
  let credentials: AuthClient['credentials'] = {
    refresh_token: options.refreshToken,
  }

  return {
    get credentials() {
      return credentials
    },
    async getAccessToken() {
      if (credentials?.access_token && credentials.expiry_date && credentials.expiry_date > Date.now()) {
        return { token: credentials.access_token }
      }

      const response = await ofetch<{ access_token: string, expires_in: number }>('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: {
          client_id: options.clientId,
          client_secret: options.clientSecret,
          refresh_token: options.refreshToken,
          grant_type: 'refresh_token',
        },
      })

      credentials = {
        ...credentials,
        access_token: response.access_token,
        expiry_date: Date.now() + response.expires_in * 1000,
      }

      return { token: response.access_token }
    },
  }
}

/** Auth can be a token string, object with accessToken, or OAuth2Client-like object with credentials */
export type Auth = string | { accessToken: string } | AuthClient | AuthOptions

async function resolveToken(auth: Auth): Promise<string> {
  if (typeof auth === 'string')
    return auth
  if ('accessToken' in auth && typeof auth.accessToken === 'string')
    return auth.accessToken
  if ('getAccessToken' in auth && typeof auth.getAccessToken === 'function') {
    const { token } = await auth.getAccessToken()
    return token || ''
  }
  if ('credentials' in auth && auth.credentials)
    return auth.credentials.access_token || ''
  return ''
}

export function createFetch(auth: Auth, options?: FetchOptions): $Fetch {
  // Normalize auth if it's options to ensure stateful client
  const authState = (typeof auth === 'object' && auth !== null && 'clientId' in auth && 'refreshToken' in auth && !('getAccessToken' in auth))
    ? createAuth(auth)
    : auth

  return ofetch.create({
    ...options,
    retry: 3,
    retryDelay: 1000,
    retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
    headers: {
      ...options?.headers,
      'Accept-Encoding': 'gzip',
      'User-Agent': 'gscdump (gzip)',
    },
    async onRequest({ options }) {
      const token = await resolveToken(authState)
      if (token) {
        options.headers = new Headers(options.headers)
        options.headers.set('Authorization', `Bearer ${token}`)
      }
    },
    async onResponseError(ctx) {
      if (ctx.response.status === 403) {
        console.error('[gscdump] Permission denied (403). check your service account permissions being added to the GSC property.')
      }

      if (options?.onResponseError) {
        if (Array.isArray(options.onResponseError)) {
          for (const handler of options.onResponseError) {
            await handler(ctx)
          }
        }
        else {
          await options.onResponseError(ctx)
        }
      }
    },
  })
}

/** Per-call options. `signal` cancels the in-flight request (and, for `query`, the next page too). */
export interface CallOptions {
  signal?: AbortSignal
}

export interface GoogleSearchConsoleClient {
  /** Query search analytics with builder, returns async generator yielding typed row batches */
  query: <D extends Dimension[], C>(siteUrl: string, builder: GSCQueryBuilder<D, C>, opts?: CallOptions) => AsyncGenerator<GSCRow<D, C>[]>

  /** List all sites */
  sites: (opts?: CallOptions) => Promise<ApiSite[]>

  /** Inspect a URL */
  inspect: (siteUrl: string, url: string, opts?: CallOptions) => Promise<InspectUrlIndexResponse>

  /** Sitemap operations */
  sitemaps: {
    list: (siteUrl: string, opts?: CallOptions) => Promise<ApiSitemap[]>
    get: (siteUrl: string, feedpath: string, opts?: CallOptions) => Promise<ApiSitemap>
    submit: (siteUrl: string, feedpath: string, opts?: CallOptions) => Promise<void>
    delete: (siteUrl: string, feedpath: string, opts?: CallOptions) => Promise<void>
  }

  /** Indexing API operations */
  indexing: {
    publish: (url: string, type: 'URL_UPDATED' | 'URL_DELETED', opts?: CallOptions) => Promise<PublishUrlNotificationResponse>
    getMetadata: (url: string, opts?: CallOptions) => Promise<UrlNotificationMetadata>
  }

  /** @internal */
  _rawQuery: (siteUrl: string, body: SearchAnalyticsQuery, opts?: CallOptions) => Promise<SearchAnalyticsResponse>
}

export interface GoogleSearchConsoleClientOptions {
  fetchOptions?: FetchOptions
  fetch?: $Fetch
  onRateLimited?: (context: { response: Response }) => void | Promise<void>
}

export function googleSearchConsole(auth: Auth, options: GoogleSearchConsoleClientOptions = {}): GoogleSearchConsoleClient {
  let fetch: $Fetch

  // Normalize auth if it's options to ensure stateful client
  const authState = (typeof auth === 'object' && auth !== null && 'clientId' in auth && 'refreshToken' in auth && !('getAccessToken' in auth))
    ? createAuth(auth)
    : auth

  if (options.fetch) {
    fetch = options.fetch
  }
  else {
    const fetchOptions = options.fetchOptions || {}
    if (options.onRateLimited) {
      const originalOnError = fetchOptions.onResponseError
      fetchOptions.onResponseError = async (ctx) => {
        if (ctx.response.status === 429) {
          await options.onRateLimited!({ response: ctx.response })
        }
        if (originalOnError) {
          if (Array.isArray(originalOnError)) {
            for (const handler of originalOnError) {
              await handler(ctx)
            }
          }
          else {
            await originalOnError(ctx)
          }
        }
      }
    }
    fetch = createFetch(authState, fetchOptions)
  }

  const rawQuery = (siteUrl: string, body: SearchAnalyticsQuery, opts?: CallOptions): Promise<SearchAnalyticsResponse> =>
    fetch<SearchAnalyticsResponse>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: 'POST',
      body,
      signal: opts?.signal,
    })

  return {
    async* query<D extends Dimension[], C>(siteUrl: string, builder: GSCQueryBuilder<D, C>, opts?: CallOptions): AsyncGenerator<GSCRow<D, C>[]> {
      const state = builder.getState()
      const body = resolveToBody(state)
      const rowLimit = body.rowLimit || 25_000
      let startRow = body.startRow || 0

      while (true) {
        opts?.signal?.throwIfAborted()
        const response = await rawQuery(siteUrl, { ...body, startRow, rowLimit }, opts)
        const rows = (response.rows || []).map((row) => {
          const result: any = {
            clicks: row.clicks ?? 0,
            impressions: row.impressions ?? 0,
            ctr: row.ctr ?? 0,
            position: row.position ?? 0,
          }
          state.dimensions.forEach((dim, i) => {
            result[dim] = row.keys?.[i]
          })
          return result as GSCRow<D, C>
        })
        yield rows
        if (rows.length < rowLimit)
          break
        startRow += rows.length
      }
    },

    sites: async (opts) => {
      const res = await fetch<{ siteEntry?: ApiSite[] }>(`${GSC_API}/webmasters/v3/sites`, { signal: opts?.signal })
      return res.siteEntry || []
    },

    inspect: (siteUrl, url, opts) =>
      fetch<InspectUrlIndexResponse>(`${GSC_API}/v1/urlInspection/index:inspect`, {
        method: 'POST',
        body: { inspectionUrl: url, siteUrl },
        signal: opts?.signal,
      }),

    sitemaps: {
      list: async (siteUrl, opts) => {
        const res = await fetch<{ sitemap?: ApiSitemap[] }>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`, { signal: opts?.signal })
        return res.sitemap || []
      },

      get: (siteUrl, feedpath, opts) =>
        fetch<ApiSitemap>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, { signal: opts?.signal }),

      submit: (siteUrl, feedpath, opts) =>
        fetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
          method: 'PUT',
          signal: opts?.signal,
        }),

      delete: (siteUrl, feedpath, opts) =>
        fetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
          method: 'DELETE',
          signal: opts?.signal,
        }),
    },

    indexing: {
      publish: (url, type, opts) =>
        fetch<PublishUrlNotificationResponse>(`${INDEXING_API}/v3/urlNotifications:publish`, {
          method: 'POST',
          body: { url, type },
          signal: opts?.signal,
        }),

      getMetadata: (url, opts) =>
        fetch<UrlNotificationMetadata>(`${INDEXING_API}/v3/urlNotifications/metadata`, {
          query: { url },
          signal: opts?.signal,
        }),
    },

    _rawQuery: rawQuery,
  }
}
