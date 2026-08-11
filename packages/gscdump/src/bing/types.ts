import type { Result } from '../core/result'

export interface BingSiteWire {
  __type?: string
  AuthenticationCode: string
  DnsVerificationCode: string
  IsVerified: boolean
  Url: string
}

export interface BingUrlInfoWire {
  __type?: string
  AnchorCount: number
  DiscoveryDate?: string | null
  DocumentSize: number
  HttpStatus: number
  IsPage: boolean
  LastCrawledDate?: string | null
  TotalChildUrlCount: number
  Url: string
}

export interface BingUrlTrafficInfoWire {
  __type?: string
  Clicks: number
  Impressions: number
  IsPage: boolean
  Url: string
}

export interface BingQueryStatsWire {
  __type?: string
  AvgClickPosition: number
  AvgImpressionPosition: number
  Clicks: number
  Date: string
  Impressions: number
  Query: string
}

export interface BingCrawlIssueWire {
  __type?: string
  HttpCode: number
  InLinks: number
  Issues: number
  Url: string
}

export interface BingWireResponse<T> {
  d: T
}

export interface BingSite {
  isVerified: boolean
  url: string
}

export interface BingUrlInfo {
  anchorCount: number
  discoveryDate?: string
  documentSize: number
  httpStatus: number
  isPage: boolean
  lastCrawledDate?: string
  totalChildUrlCount: number
  url: string
}

export interface BingUrlTrafficInfo {
  clicks: number
  impressions: number
  isPage: boolean
  url: string
}

export interface BingPageStats {
  averageClickPosition: number
  averageImpressionPosition: number
  clicks: number
  date: string
  impressions: number
  query: string
}

export type BingCrawlIssue
  = | 'none'
    | '301'
    | '302'
    | '4xx'
    | '5xx'
    | 'blocked-by-robots-txt'
    | 'contains-malware'
    | 'important-url-blocked-by-robots-txt'
    | 'dns-errors'
    | 'timeout-errors'
    | 'unknown'

export interface BingUrlWithCrawlIssues {
  httpCode: number
  inLinks: number
  issue: BingCrawlIssue
  rawIssueCode: number
  url: string
}

export interface BingCrawlEvidence {
  _tag: 'CrawlEvidence'
  anchorCount: number
  discoveryDate?: string
  documentSize: number
  httpStatus: number
  lastCrawledDate?: string
  observedAt: string
  rawStatus: number
  searchEngine: 'bing'
  totalChildUrlCount: number
  uncertaintyReason: 'indexed-verdict-unavailable'
  url: string
}

export interface BingUnknownEvidence {
  _tag: 'UnknownEvidence'
  observedAt: string
  reason: 'not-discovered' | 'not-observed'
  searchEngine: 'bing'
  url: string
}

export type BingIndexingEvidence = BingCrawlEvidence | BingUnknownEvidence

export type BingProviderError
  = | { _tag: 'AuthenticationRequired' }
    | { _tag: 'PermissionDenied' }
    | { _tag: 'UserBlocked' }
    | { _tag: 'UnverifiedSite', siteUrl: string }
    | { _tag: 'SiteUnavailable', siteUrl: string }
    | { _tag: 'Throttled', retryAfterMs?: number }
    | { _tag: 'ProviderUnavailable', status: number }
    | { _tag: 'RequestRejected', errorCode?: number, message?: string, status: number }
    | { _tag: 'MalformedResponse', operation: BingOperation, reason: 'invalid-json' | 'invalid-payload' }
    | { _tag: 'InvalidPagination', maximum: number, maxPages: number, minimum: number, reason: 'max-pages-out-of-range' }
    | { _tag: 'PaginationLimitExceeded', maxPages: number }

export interface BingEvidenceError {
  _tag: 'UnsupportedEvidence'
  reason: 'not-a-page'
  url: string
}

export type BingOperation
  = | 'GetUserSites'
    | 'GetUrlInfo'
    | 'GetUrlTrafficInfo'
    | 'GetChildrenUrlInfo'
    | 'GetPageStats'
    | 'GetCrawlIssues'

export interface BingCallOptions {
  signal?: AbortSignal
}

export type BingCrawlDateFilter = 'any' | 'last-week' | 'last-two-weeks' | 'last-three-weeks'
export type BingDiscoveredDateFilter = 'any' | 'last-week' | 'last-month'
export type BingDocumentFilter = 'any' | 'blocked-by-robots-txt' | 'malware'
export type BingHttpCodeFilter = 'any' | '2xx' | '3xx' | '301' | '302' | '4xx' | '5xx' | 'other'

export interface BingChildrenFilters {
  crawlDate?: BingCrawlDateFilter
  discoveredDate?: BingDiscoveredDateFilter
  document?: BingDocumentFilter
  httpCode?: BingHttpCodeFilter
}

export interface BingChildrenOptions extends BingCallOptions {
  filters?: BingChildrenFilters
  maxPages?: number
}

export interface BingWebmasterClient {
  getUserSites: (options?: BingCallOptions) => Promise<Result<BingSite[], BingProviderError>>
  getVerifiedSite: (siteUrl: string, options?: BingCallOptions) => Promise<Result<BingSite, BingProviderError>>
  getUrlInfo: (siteUrl: string, url: string, options?: BingCallOptions) => Promise<Result<BingUrlInfo | null, BingProviderError>>
  getIndexingEvidence: (siteUrl: string, url: string, options?: BingCallOptions) => Promise<Result<BingIndexingEvidence, BingProviderError | BingEvidenceError>>
  getUrlTrafficInfo: (siteUrl: string, url: string, options?: BingCallOptions) => Promise<Result<BingUrlTrafficInfo | null, BingProviderError>>
  getChildrenUrlInfo: (siteUrl: string, url: string, options?: BingChildrenOptions) => Promise<Result<BingUrlInfo[], BingProviderError>>
  getPageStats: (siteUrl: string, options?: BingCallOptions) => Promise<Result<BingPageStats[], BingProviderError>>
  getCrawlIssues: (siteUrl: string, options?: BingCallOptions) => Promise<Result<BingUrlWithCrawlIssues[], BingProviderError>>
}

export type BingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface BingWebmasterOptions {
  accessToken: string
  baseUrl?: string
  clock?: () => Date
  fetch?: BingFetch
}
