import type { GoogleSearchConsoleClient } from 'gscdump/client'
import type { FetchOptions } from 'ofetch'
import type { CloudAuthentication } from './auth-state'
import { googleSearchConsole } from 'gscdump/client'
import { ofetch } from 'ofetch'
import { cloudRequest } from './auth-state'

/** Keep the Google query builder and pagination while routing supported requests through the hosted API. */
export function createCloudGoogleClient(state: CloudAuthentication, fetchOptions?: FetchOptions): GoogleSearchConsoleClient {
  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.origin !== 'https://searchconsole.googleapis.com')
      throw new Error('Google indexing and Site Verification require local authentication. Use --mode local.')

    const method = init?.method ?? 'GET'
    const signal = init?.signal
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    const post = (route: string, data: Record<string, unknown>): Promise<unknown> => cloudRequest(state, `/cli/gsc/${route}`, {
      method: 'POST',
      body: JSON.stringify(data),
      signal,
    })
    let result: unknown

    if (url.pathname === '/webmasters/v3/sites' && method === 'GET') {
      result = { siteEntry: await cloudRequest(state, '/cli/gsc/sites', { signal }) }
    }
    else if (url.pathname === '/v1/urlInspection/index:inspect' && method === 'POST') {
      result = await post('inspect', { siteUrl: body.siteUrl, urls: [body.inspectionUrl], languageCode: body.languageCode, raw: true })
    }
    else {
      const match = url.pathname.match(/^\/webmasters\/v3\/sites\/([^/]+)(?:\/(searchAnalytics\/query|sitemaps)(?:\/([^/]+))?)?$/)
      if (!match)
        throw new Error('This Google operation requires local authentication. Use --mode local.')
      const siteUrl = decodeURIComponent(match[1])
      if (match[2] === 'searchAnalytics/query' && method === 'POST') {
        const { type, ...query } = body
        result = await post('query', { ...query, siteUrl, searchType: type, raw: true })
      }
      else if (match[2] === 'sitemaps') {
        if (match[3]) {
          const action = method === 'GET' ? 'get' : method === 'PUT' ? 'submit' : method === 'DELETE' ? 'delete' : null
          if (!action)
            throw new Error('This sitemap operation requires local authentication. Use --mode local.')
          const response = await post('sitemaps', { siteUrl, sitemapUrl: decodeURIComponent(match[3]), action })
          result = action === 'get' ? response : undefined
        }
        else if (method === 'GET') {
          const query = new URLSearchParams({ siteUrl, raw: 'true' })
          const sitemapIndex = url.searchParams.get('sitemapIndex')
          if (sitemapIndex)
            query.set('sitemapIndex', sitemapIndex)
          const response = await cloudRequest(state, `/cli/gsc/sitemaps?${query}`, { signal }) as { sitemaps: unknown[] }
          result = { sitemap: response.sitemaps }
        }
        else {
          throw new Error('This sitemap operation requires local authentication. Use --mode local.')
        }
      }
      else if (!match[2]) {
        const action = method === 'GET' ? 'get' : method === 'PUT' ? 'add' : method === 'DELETE' ? 'remove' : null
        if (!action)
          throw new Error('This Site operation requires local authentication. Use --mode local.')
        const response = await post('sites', { siteUrl, action })
        result = action === 'get' ? response : undefined
      }
      else {
        throw new Error('This Google operation requires local authentication. Use --mode local.')
      }
    }
    return result === undefined ? new Response(null, { status: 204 }) : Response.json(result)
  }
  const fetchHosted = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => request(input, init).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'response' in error && error.response instanceof Response)
      return error.response
    throw error
  })
  return googleSearchConsole('', {
    fetch: ofetch.create({
      ...fetchOptions,
      retry: fetchOptions?.retry ?? 3,
      timeout: fetchOptions?.timeout ?? 30_000,
      async onRequest(context) {
        if (new URL(String(context.request)).origin !== 'https://searchconsole.googleapis.com')
          throw new Error('Google indexing and Site Verification require local authentication. Use --mode local.')
        const hooks = fetchOptions?.onRequest
        for (const hook of hooks ? Array.isArray(hooks) ? hooks : [hooks] : [])
          await hook(context)
      },
      retryDelay: fetchOptions?.retryDelay ?? (({ response }) => {
        const header = response?.headers.get('retry-after')
        if (header) {
          const seconds = Number(header)
          if (Number.isFinite(seconds))
            return Math.max(0, seconds * 1000)
          const date = Date.parse(header)
          if (Number.isFinite(date))
            return Math.max(0, date - Date.now())
        }
        return 1000
      }),
    }, { fetch: fetchHosted as typeof fetch }),
  })
}
