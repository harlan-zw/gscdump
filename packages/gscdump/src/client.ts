import type { indexing_v3 } from '@googleapis/indexing/v3'
import type { searchconsole_v1 } from '@googleapis/searchconsole/v1'
import { ofetch } from 'ofetch'

const GSC_API = 'https://searchconsole.googleapis.com'
const INDEXING_API = 'https://indexing.googleapis.com'

/** Auth can be a token string, object with accessToken, or OAuth2Client-like object with credentials */
export type GscAuth = string | { accessToken: string } | { credentials: { access_token?: string | null } }

function getToken(auth: GscAuth): string {
  if (typeof auth === 'string')
    return auth
  if ('accessToken' in auth)
    return auth.accessToken
  return auth.credentials.access_token || ''
}

export const gscClient = {
  sites: {
    list: (auth: GscAuth) =>
      ofetch<{ siteEntry?: searchconsole_v1.Schema$WmxSite[] }>(`${GSC_API}/webmasters/v3/sites`, {
        headers: { Authorization: `Bearer ${getToken(auth)}` },
      }),
  },

  sitemaps: {
    list: (auth: GscAuth, siteUrl: string) =>
      ofetch<{ sitemap?: searchconsole_v1.Schema$WmxSitemap[] }>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {
        headers: { Authorization: `Bearer ${getToken(auth)}` },
      }),

    get: (auth: GscAuth, siteUrl: string, feedpath: string) =>
      ofetch<searchconsole_v1.Schema$WmxSitemap>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
        headers: { Authorization: `Bearer ${getToken(auth)}` },
      }),

    submit: (auth: GscAuth, siteUrl: string, feedpath: string) =>
      ofetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${getToken(auth)}` },
      }),

    delete: (auth: GscAuth, siteUrl: string, feedpath: string) =>
      ofetch<void>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${getToken(auth)}` },
      }),
  },

  searchAnalytics: {
    query: (auth: GscAuth, siteUrl: string, body: searchconsole_v1.Schema$SearchAnalyticsQueryRequest) =>
      ofetch<searchconsole_v1.Schema$SearchAnalyticsQueryResponse>(`${GSC_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getToken(auth)}`,
          'Accept-Encoding': 'gzip',
          'User-Agent': 'gscdump (gzip)',
        },
        body,
      }),
  },

  urlInspection: {
    inspect: (auth: GscAuth, siteUrl: string, inspectionUrl: string) =>
      ofetch<searchconsole_v1.Schema$InspectUrlIndexResponse>(`${GSC_API}/v1/urlInspection/index:inspect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken(auth)}` },
        body: { inspectionUrl, siteUrl },
      }),
  },

  indexing: {
    publish: (auth: GscAuth, url: string, type: 'URL_UPDATED' | 'URL_DELETED') =>
      ofetch<indexing_v3.Schema$PublishUrlNotificationResponse>(`${INDEXING_API}/v3/urlNotifications:publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken(auth)}` },
        body: { url, type },
      }),

    getMetadata: (auth: GscAuth, url: string) =>
      ofetch<indexing_v3.Schema$UrlNotificationMetadata>(`${INDEXING_API}/v3/urlNotifications/metadata`, {
        headers: { Authorization: `Bearer ${getToken(auth)}` },
        query: { url },
      }),
  },
}
