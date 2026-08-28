import type { Result } from '../core/result'
import type {
  BingCallOptions,
  BingChildrenFilters,
  BingChildrenOptions,
  BingCrawlDateFilter,
  BingDiscoveredDateFilter,
  BingDocumentFilter,
  BingHttpCodeFilter,
  BingOperation,
  BingProviderError,
  BingSite,
  BingUrlInfo,
  BingWebmasterClient,
  BingWebmasterOptions,
} from './types'
import { err, ok } from '../core/result'
import {
  normalizeBingCrawlIssue,
  normalizeBingCrawlStats,
  normalizeBingIndexingEvidence,
  normalizeBingPageStats,
  normalizeBingQueryStats,
  normalizeBingRankAndTrafficStats,
  normalizeBingSite,
  normalizeBingUrlInfo,
  normalizeBingUrlTrafficInfo,
} from './normalize'

export const DEFAULT_BING_WEBMASTER_API_URL = 'https://www.bing.com/webmaster/api.svc/json'
export const DEFAULT_BING_CHILD_PAGE_LIMIT = 100
const BING_MAX_CHILD_PAGE_COUNT = 65_536

interface BingApiErrorPayload {
  ErrorCode?: number
  Message?: string
}

interface InternalRequest {
  body?: unknown
  method?: 'GET' | 'POST'
  query?: Record<string, string>
  signal?: AbortSignal
}

type BoundaryParser<T> = (value: unknown) => Result<T, 'invalid-payload'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseErrorPayload(value: unknown): BingApiErrorPayload {
  if (!isRecord(value))
    return {}
  return {
    ...(typeof value.ErrorCode === 'number' ? { ErrorCode: value.ErrorCode } : {}),
    ...(typeof value.Message === 'string' ? { Message: value.Message } : {}),
  }
}

function retryAfterMs(response: Response, now: Date): number | undefined {
  const header = response.headers.get('retry-after')
  if (!header)
    return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0)
    return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isFinite(date))
    return undefined
  return Math.max(0, date - now.getTime())
}

function mapResponseError(response: Response, payload: unknown, now: Date): BingProviderError {
  const apiError = parseErrorPayload(payload)
  if (response.status === 401 || apiError.ErrorCode === 3)
    return { _tag: 'AuthenticationRequired' }
  if (apiError.ErrorCode === 6)
    return { _tag: 'UserBlocked' }
  if (response.status === 403 || apiError.ErrorCode === 14)
    return { _tag: 'PermissionDenied' }
  if (response.status === 429 || apiError.ErrorCode === 4 || apiError.ErrorCode === 5) {
    const delay = retryAfterMs(response, now)
    return {
      _tag: 'Throttled',
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    }
  }
  if (response.status >= 500)
    return { _tag: 'ProviderUnavailable', status: response.status }
  return {
    _tag: 'RequestRejected',
    ...(apiError.ErrorCode === undefined ? {} : { errorCode: apiError.ErrorCode }),
    ...(apiError.Message === undefined ? {} : { message: apiError.Message }),
    status: response.status,
  }
}

function parseWrapped<T>(value: unknown, parser: BoundaryParser<T>): Result<T, 'invalid-payload'> {
  if (!isRecord(value) || !Object.hasOwn(value, 'd'))
    return err('invalid-payload')
  return parser(value.d)
}

function parseNullable<T>(parser: BoundaryParser<T>): BoundaryParser<T | null> {
  return (value) => {
    if (value === null)
      return ok(null)
    return parser(value)
  }
}

function parseList<T>(parser: BoundaryParser<T>): BoundaryParser<T[]> {
  return (value) => {
    if (!Array.isArray(value))
      return err('invalid-payload')
    const parsed: T[] = []
    for (const item of value) {
      const result = parser(item)
      if (!result.ok)
        return result
      parsed.push(result.value)
    }
    return ok(parsed)
  }
}

const CRAWL_DATE_FILTERS: Readonly<Record<BingCrawlDateFilter, number>> = {
  'any': 0,
  'last-week': 1,
  'last-two-weeks': 2,
  'last-three-weeks': 4,
}

const DISCOVERED_DATE_FILTERS: Readonly<Record<BingDiscoveredDateFilter, number>> = {
  'any': 0,
  'last-week': 1,
  'last-month': 2,
}

const DOCUMENT_FILTERS: Readonly<Record<BingDocumentFilter, number>> = {
  'any': 0,
  'blocked-by-robots-txt': 1,
  'malware': 2,
}

const HTTP_CODE_FILTERS: Readonly<Record<BingHttpCodeFilter, number>> = {
  'any': 0,
  '2xx': 1,
  '3xx': 2,
  '301': 4,
  '302': 8,
  '4xx': 16,
  '5xx': 32,
  'other': 64,
}

function toFilterProperties(filters: BingChildrenFilters = {}): Record<string, unknown> {
  return {
    __type: 'FilterProperties:#Microsoft.Bing.Webmaster.Api',
    CrawlDateFilter: CRAWL_DATE_FILTERS[filters.crawlDate ?? 'any'],
    DiscoveredDateFilter: DISCOVERED_DATE_FILTERS[filters.discoveredDate ?? 'any'],
    DocFlagsFilters: DOCUMENT_FILTERS[filters.document ?? 'any'],
    HttpCodeFilters: HTTP_CODE_FILTERS[filters.httpCode ?? 'any'],
  }
}

export function bingWebmaster(options: BingWebmasterOptions): BingWebmasterClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BING_WEBMASTER_API_URL).replace(/\/+$/, '')
  const clock = options.clock ?? (() => new Date())
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  const request = async <T>(
    operation: BingOperation,
    parser: BoundaryParser<T>,
    input: InternalRequest = {},
  ): Promise<Result<T, BingProviderError>> => {
    if (!options.accessToken.trim())
      return err({ _tag: 'AuthenticationRequired' })

    const url = new URL(`${baseUrl}/${operation}`)
    for (const [key, value] of Object.entries(input.query ?? {}))
      url.searchParams.set(key, value)

    const response = await fetch(url.toString(), {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.accessToken}`,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      },
      method: input.method ?? 'GET',
      signal: input.signal,
    })

    const payload = await response.json()
      .then(value => ok(value))
      .catch(() => err<'invalid-json'>('invalid-json'))
    if (!response.ok)
      return err(mapResponseError(response, payload.ok ? payload.value : undefined, clock()))

    if (!payload.ok) {
      return err({
        _tag: 'MalformedResponse',
        operation,
        reason: 'invalid-json',
      })
    }

    const parsed = parseWrapped(payload.value, parser)
    if (!parsed.ok) {
      return err({
        _tag: 'MalformedResponse',
        operation,
        reason: 'invalid-payload',
      })
    }
    return parsed
  }

  const getUserSites = (callOptions?: BingCallOptions): Promise<Result<BingSite[], BingProviderError>> =>
    request('GetUserSites', parseList(normalizeBingSite), { signal: callOptions?.signal })

  const getUrlInfo = (siteUrl: string, url: string, callOptions?: BingCallOptions): Promise<Result<BingUrlInfo | null, BingProviderError>> => request(
    'GetUrlInfo',
    parseNullable(normalizeBingUrlInfo),
    { query: { siteUrl, url }, signal: callOptions?.signal },
  )

  return {
    getUserSites,

    async getVerifiedSite(siteUrl, callOptions) {
      const sites = await getUserSites(callOptions)
      if (!sites.ok)
        return sites
      const site = sites.value.find(candidate => candidate.url === siteUrl)
      if (!site)
        return err({ _tag: 'SiteUnavailable', siteUrl })
      if (!site.isVerified)
        return err({ _tag: 'UnverifiedSite', siteUrl })
      return ok(site)
    },

    getUrlInfo,

    async getIndexingEvidence(siteUrl, url, callOptions) {
      const info = await getUrlInfo(siteUrl, url, callOptions)
      if (!info.ok)
        return info
      return normalizeBingIndexingEvidence(info.value, url, clock())
    },

    getUrlTrafficInfo: (siteUrl, url, callOptions) => request(
      'GetUrlTrafficInfo',
      parseNullable(normalizeBingUrlTrafficInfo),
      { query: { siteUrl, url }, signal: callOptions?.signal },
    ),

    async getChildrenUrlInfo(siteUrl, url, childrenOptions: BingChildrenOptions = {}) {
      const maxPages = childrenOptions.maxPages ?? DEFAULT_BING_CHILD_PAGE_LIMIT
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > BING_MAX_CHILD_PAGE_COUNT) {
        return err({
          _tag: 'InvalidPagination',
          maximum: BING_MAX_CHILD_PAGE_COUNT,
          maxPages,
          minimum: 1,
          reason: 'max-pages-out-of-range',
        })
      }
      const children: BingUrlInfo[] = []

      for (let page = 0; page < maxPages; page++) {
        const response = await request(
          'GetChildrenUrlInfo',
          parseList(normalizeBingUrlInfo),
          {
            body: {
              filterProperties: toFilterProperties(childrenOptions.filters),
              page,
              siteUrl,
              url,
            },
            method: 'POST',
            signal: childrenOptions.signal,
          },
        )
        if (!response.ok)
          return response
        if (response.value.length === 0)
          return ok(children)
        children.push(...response.value)
      }

      return err({ _tag: 'PaginationLimitExceeded', maxPages })
    },

    getPageStats: (siteUrl, callOptions) => request(
      'GetPageStats',
      parseList(normalizeBingPageStats),
      { query: { siteUrl }, signal: callOptions?.signal },
    ),

    getQueryStats: (siteUrl, callOptions) => request(
      'GetQueryStats',
      parseList(normalizeBingQueryStats),
      { query: { siteUrl }, signal: callOptions?.signal },
    ),

    getRankAndTrafficStats: (siteUrl, callOptions) => request(
      'GetRankAndTrafficStats',
      parseList(normalizeBingRankAndTrafficStats),
      { query: { siteUrl }, signal: callOptions?.signal },
    ),

    getCrawlStats: (siteUrl, callOptions) => request(
      'GetCrawlStats',
      parseList(normalizeBingCrawlStats),
      { query: { siteUrl }, signal: callOptions?.signal },
    ),

    getCrawlIssues: (siteUrl, callOptions) => request(
      'GetCrawlIssues',
      parseList(normalizeBingCrawlIssue),
      { query: { siteUrl }, signal: callOptions?.signal },
    ),
  }
}
