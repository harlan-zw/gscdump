import type { $Fetch, FetchContext, FetchOptions } from 'ofetch'
import type { GscResponseAggregationType, GscSearchAnalyticsMetadata } from '../contracts'
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
import { rowWithMetricDefaults } from './cli-format'

const GSC_API = 'https://searchconsole.googleapis.com'
const INDEXING_API = 'https://indexing.googleapis.com'
const SITE_VERIFICATION_API = 'https://www.googleapis.com/siteVerification/v1'

/**
 * Encode a GSC `siteUrl` for use in a path segment. Preserves the literal
 * `sc-domain:` prefix used by Domain properties so the colon doesn't get
 * percent-encoded (Google accepts either, but the docs use the literal form).
 */
function encodeSiteUrl(siteUrl: string): string {
  if (siteUrl.startsWith('sc-domain:'))
    return `sc-domain:${encodeURIComponent(siteUrl.slice('sc-domain:'.length))}`
  return encodeURIComponent(siteUrl)
}

/**
 * GSC accepts a URL-prefix property (`http://…` or `https://…`, with trailing
 * slash) or a Domain property (`sc-domain:example.com`). Anything else is
 * rejected with a 400, so guard at the SDK boundary.
 */
function assertValidSiteUrl(siteUrl: string): void {
  if (siteUrl.startsWith('sc-domain:') && siteUrl.length > 'sc-domain:'.length)
    return
  if (/^https?:\/\/.+/.test(siteUrl))
    return
  throw new Error(`Invalid siteUrl: expected "https?://…" or "sc-domain:…", got "${siteUrl}"`)
}

export type VerificationMethod = 'META' | 'FILE' | 'DNS_TXT' | 'DNS_CNAME' | 'ANALYTICS' | 'TAG_MANAGER'
export type VerificationSiteType = 'SITE' | 'INET_DOMAIN' | 'ANDROID_APP'

export interface VerificationSite {
  type: VerificationSiteType
  identifier: string
}

export interface VerificationToken {
  method: string
  token: string
}

export interface VerificationWebResource {
  id?: string
  site: VerificationSite
  owners?: string[]
}

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
    // Honour `Retry-After` on 429/503 (RFC 7231): seconds or HTTP-date.
    // Fall back to 1s for other retryable codes.
    retryDelay: (ctx: FetchContext) => {
      const status = ctx.response?.status
      if (status === 429 || status === 503) {
        const header = ctx.response?.headers.get('retry-after')
        if (header) {
          const secs = Number.parseInt(header, 10)
          if (Number.isFinite(secs))
            return secs * 1000
          const when = Date.parse(header)
          if (Number.isFinite(when))
            return Math.max(0, when - Date.now())
        }
      }
      return 1000
    },
    retryStatusCodes: [408, 425, 429, 500, 502, 503, 504],
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

/** Generator return value for `client.query` — exposes API response metadata plus the resolved aggregation type Google actually used (may differ from the requested `aggregationType: 'auto'`). */
export interface QueryReturn {
  metadata?: GscSearchAnalyticsMetadata
  /** Aggregation type Google actually used. Useful when requesting `auto` to know if rows were aggregated `byPage` vs `byProperty`. */
  responseAggregationType?: GscResponseAggregationType
}

export interface GoogleSearchConsoleClient {
  /** Query search analytics with builder, returns async generator yielding typed row batches */
  query: <D extends Dimension[], C>(siteUrl: string, builder: GSCQueryBuilder<D, C>, opts?: CallOptions) => AsyncGenerator<GSCRow<D, C>[], QueryReturn>

  /**
   * List all sites. Also exposes write ops as `client.sites.add(siteUrl)` and
   * `client.sites.delete(siteUrl)`. Calling `client.sites()` is equivalent to
   * `client.sites.list()`.
   */
  sites: ((opts?: CallOptions) => Promise<ApiSite[]>) & {
    list: (opts?: CallOptions) => Promise<ApiSite[]>
    /** Retrieve a single property (with permission level). 404 if not in the user's account. */
    get: (siteUrl: string, opts?: CallOptions) => Promise<ApiSite>
    /** Add a property in unverified state. Caller must verify ownership separately. */
    add: (siteUrl: string, opts?: CallOptions) => Promise<void>
    /** Remove a property from the user's account. */
    delete: (siteUrl: string, opts?: CallOptions) => Promise<void>
  }

  /** Site Verification API (siteverification.googleapis.com). Required to flip a property from unverified to verified. */
  verification: {
    /** Returns the token to place on the site/DNS, plus the resolved method. */
    getToken: (params: { site: VerificationSite, verificationMethod: VerificationMethod }, opts?: CallOptions) => Promise<VerificationToken>
    /** Triggers Google to fetch + validate; returns the verified WebResource. */
    insert: (params: { site: VerificationSite, verificationMethod: VerificationMethod }, opts?: CallOptions) => Promise<VerificationWebResource>
    list: (opts?: CallOptions) => Promise<VerificationWebResource[]>
    get: (id: string, opts?: CallOptions) => Promise<VerificationWebResource>
    delete: (id: string, opts?: CallOptions) => Promise<void>
  }

  /** Inspect a URL. `languageCode` is a BCP-47 tag for translating result strings; omit to let Google pick. */
  inspect: (siteUrl: string, url: string, opts?: CallOptions & { languageCode?: string }) => Promise<InspectUrlIndexResponse>

  /** Sitemap operations */
  sitemaps: {
    /** List sitemaps. Pass `sitemapIndex` to list children of a sitemap-index file. */
    list: (siteUrl: string, opts?: CallOptions & { sitemapIndex?: string }) => Promise<ApiSitemap[]>
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
    fetch<SearchAnalyticsResponse>(`${GSC_API}/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/searchAnalytics/query`, {
      method: 'POST',
      body,
      signal: opts?.signal,
    })

  return {
    async* query<D extends Dimension[], C>(siteUrl: string, builder: GSCQueryBuilder<D, C>, opts?: CallOptions): AsyncGenerator<GSCRow<D, C>[], QueryReturn> {
      const state = builder.getState()
      const body = resolveToBody(state)
      // When the caller specifies rowLimit it's a *total* cap; per-page we
      // still use the API max (25k) to minimise round-trips.
      const totalCap = body.rowLimit
      const pageSize = Math.min(totalCap ?? 25_000, 25_000)
      let startRow = body.startRow || 0
      let yielded = 0
      let metadata: GscSearchAnalyticsMetadata | undefined
      let responseAggregationType: GscResponseAggregationType | undefined

      while (true) {
        opts?.signal?.throwIfAborted()
        const remaining = totalCap ? totalCap - yielded : pageSize
        if (remaining <= 0)
          break
        const rowLimit = Math.min(pageSize, remaining)
        const response = await rawQuery(siteUrl, { ...body, startRow, rowLimit }, opts)
        if (response.metadata)
          metadata = response.metadata as GscSearchAnalyticsMetadata
        if (response.responseAggregationType)
          responseAggregationType = response.responseAggregationType as GscResponseAggregationType
        const rows = (response.rows || []).map((row) => {
          const result: any = rowWithMetricDefaults(row)
          state.dimensions.forEach((dim, i) => {
            result[dim] = row.keys?.[i]
          })
          return result as GSCRow<D, C>
        })
        // Per Google docs (how-tos/all-your-data): paginate until rows.length === 0.
        // Short pages are not a reliable end-of-data signal. Don't yield empty
        // batches — they're a pagination implementation detail.
        if (rows.length === 0)
          break
        yield rows
        yielded += rows.length
        startRow += rows.length
      }
      return { metadata, responseAggregationType }
    },

    sites: (() => {
      const list = async (opts?: CallOptions): Promise<ApiSite[]> => {
        const res = await fetch<{ siteEntry?: ApiSite[] }>(`${GSC_API}/webmasters/v3/sites`, { signal: opts?.signal })
        return res.siteEntry || []
      }
      return Object.assign(list, {
        list,
        get: (siteUrl: string, opts?: CallOptions) =>
          fetch<ApiSite>(`${GSC_API}/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}`, { signal: opts?.signal }),
        add: (siteUrl: string, opts?: CallOptions) => {
          assertValidSiteUrl(siteUrl)
          return fetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}`, {
            method: 'PUT',
            signal: opts?.signal,
          })
        },
        delete: (siteUrl: string, opts?: CallOptions) =>
          fetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}`, {
            method: 'DELETE',
            signal: opts?.signal,
          }),
      })
    })(),

    verification: {
      getToken: (params, opts) =>
        fetch<VerificationToken>(`${SITE_VERIFICATION_API}/token`, {
          method: 'POST',
          body: params,
          signal: opts?.signal,
        }),
      insert: (params, opts) =>
        fetch<VerificationWebResource>(`${SITE_VERIFICATION_API}/webResource`, {
          method: 'POST',
          query: { verificationMethod: params.verificationMethod },
          body: { site: params.site },
          signal: opts?.signal,
        }),
      list: async (opts) => {
        const res = await fetch<{ items?: VerificationWebResource[] }>(`${SITE_VERIFICATION_API}/webResource`, { signal: opts?.signal })
        return res.items || []
      },
      get: (id, opts) =>
        fetch<VerificationWebResource>(`${SITE_VERIFICATION_API}/webResource/${encodeURIComponent(id)}`, { signal: opts?.signal }),
      delete: (id, opts) =>
        fetch<void>(`${SITE_VERIFICATION_API}/webResource/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          signal: opts?.signal,
        }),
    },

    inspect: (siteUrl, url, opts) =>
      fetch<InspectUrlIndexResponse>(`${GSC_API}/v1/urlInspection/index:inspect`, {
        method: 'POST',
        body: opts?.languageCode
          ? { inspectionUrl: url, siteUrl, languageCode: opts.languageCode }
          : { inspectionUrl: url, siteUrl },
        signal: opts?.signal,
      }),

    sitemaps: {
      list: async (siteUrl, opts) => {
        const res = await fetch<{ sitemap?: ApiSitemap[] }>(`${GSC_API}/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/sitemaps`, {
          signal: opts?.signal,
          query: opts?.sitemapIndex ? { sitemapIndex: opts.sitemapIndex } : undefined,
        })
        return res.sitemap || []
      },

      get: (siteUrl, feedpath, opts) =>
        fetch<ApiSitemap>(`${GSC_API}/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, { signal: opts?.signal }),

      submit: (siteUrl, feedpath, opts) =>
        fetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
          method: 'PUT',
          signal: opts?.signal,
        }),

      delete: (siteUrl, feedpath, opts) =>
        fetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
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
