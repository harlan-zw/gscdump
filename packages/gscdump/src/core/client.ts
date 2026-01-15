import type { $Fetch, FetchOptions } from 'ofetch'
import { ofetch } from 'ofetch'
import type {
  ApiSite,
  ApiSitemap,
  InspectUrlIndexResponse,
  PublishUrlNotificationResponse,
  SearchAnalyticsQuery,
  SearchAnalyticsResponse,
  UrlNotificationMetadata,
} from './types'

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

export interface GoogleSearchConsoleClient {
  sites: { list: () => Promise<{ siteEntry?: ApiSite[] }> }
  sitemaps: {
    list: (siteUrl: string) => Promise<{ sitemap?: ApiSitemap[] }>
    get: (siteUrl: string, feedpath: string) => Promise<ApiSitemap>
    submit: (siteUrl: string, feedpath: string) => Promise<void>
    delete: (siteUrl: string, feedpath: string) => Promise<void>
  }
  searchAnalytics: {
    query: (siteUrl: string, body: SearchAnalyticsQuery) => Promise<SearchAnalyticsResponse>
  }
  urlInspection: {
    inspect: (siteUrl: string, inspectionUrl: string) => Promise<InspectUrlIndexResponse>
  }
  indexing: {
    publish: (url: string, type: 'URL_UPDATED' | 'URL_DELETED') => Promise<PublishUrlNotificationResponse>
    getMetadata: (url: string) => Promise<UrlNotificationMetadata>
  }
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

  return {
    sites: {
      list: () =>
        fetch<{ siteEntry?: ApiSite[] }>(`${GSC_API}/webmasters/v3/sites`),
    },

    sitemaps: {
      list: (siteUrl: string) =>
        fetch<{ sitemap?: ApiSitemap[] }>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`),

      get: (siteUrl: string, feedpath: string) =>
        fetch<ApiSitemap>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`),

      submit: (siteUrl: string, feedpath: string) =>
        fetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
          method: 'PUT',
        }),

      delete: (siteUrl: string, feedpath: string) =>
        fetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
          method: 'DELETE',
        }),
    },

    searchAnalytics: {
      query: (siteUrl: string, body: SearchAnalyticsQuery) =>
        fetch<SearchAnalyticsResponse>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
          method: 'POST',
          body,
        }),
    },

    urlInspection: {
      inspect: (siteUrl: string, inspectionUrl: string) =>
        fetch<InspectUrlIndexResponse>(`${GSC_API}/v1/urlInspection/index:inspect`, {
          method: 'POST',
          body: { inspectionUrl, siteUrl },
        }),
    },

    indexing: {
      publish: (url: string, type: 'URL_UPDATED' | 'URL_DELETED') =>
        fetch<PublishUrlNotificationResponse>(`${INDEXING_API}/v3/urlNotifications:publish`, {
          method: 'POST',
          body: { url, type },
        }),

      getMetadata: (url: string) =>
        fetch<UrlNotificationMetadata>(`${INDEXING_API}/v3/urlNotifications/metadata`, {
          query: { url },
        }),
    },
  }
}