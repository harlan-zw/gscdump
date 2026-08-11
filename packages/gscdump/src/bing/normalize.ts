import type { Result } from '../core/result'
import type {
  BingCrawlIssue,
  BingEvidenceError,
  BingIndexingEvidence,
  BingPageStats,
  BingSite,
  BingUrlInfo,
  BingUrlTrafficInfo,
  BingUrlWithCrawlIssues,
} from './types'
import { err, ok } from '../core/result'

const BING_UNAVAILABLE_DATE_MS = -62_135_568_000_000
const BING_DATE_PATTERN = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseBingDate(value: unknown): Result<string | undefined, 'invalid-date'> {
  if (value === undefined || value === null)
    return ok(undefined)
  if (typeof value !== 'string')
    return err('invalid-date')
  const match = BING_DATE_PATTERN.exec(value)
  if (!match)
    return err('invalid-date')
  const milliseconds = Number(match[1])
  if (!Number.isFinite(milliseconds))
    return err('invalid-date')
  if (milliseconds <= BING_UNAVAILABLE_DATE_MS)
    return ok(undefined)
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime()))
    return err('invalid-date')
  return ok(date.toISOString())
}

export function normalizeBingSite(value: unknown): Result<BingSite, 'invalid-payload'> {
  if (!isRecord(value)
    || typeof value.IsVerified !== 'boolean'
    || typeof value.Url !== 'string') {
    return err('invalid-payload')
  }

  return ok({
    isVerified: value.IsVerified,
    url: value.Url,
  })
}

export function normalizeBingUrlInfo(value: unknown): Result<BingUrlInfo, 'invalid-payload'> {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.AnchorCount)
    || !isNonNegativeInteger(value.DocumentSize)
    || !isNonNegativeInteger(value.HttpStatus)
    || typeof value.IsPage !== 'boolean'
    || !isNonNegativeInteger(value.TotalChildUrlCount)
    || typeof value.Url !== 'string') {
    return err('invalid-payload')
  }

  const discoveryDate = parseBingDate(value.DiscoveryDate)
  const lastCrawledDate = parseBingDate(value.LastCrawledDate)
  if (!discoveryDate.ok || !lastCrawledDate.ok)
    return err('invalid-payload')

  return ok({
    anchorCount: value.AnchorCount,
    ...(discoveryDate.value ? { discoveryDate: discoveryDate.value } : {}),
    documentSize: value.DocumentSize,
    httpStatus: value.HttpStatus,
    isPage: value.IsPage,
    ...(lastCrawledDate.value ? { lastCrawledDate: lastCrawledDate.value } : {}),
    totalChildUrlCount: value.TotalChildUrlCount,
    url: value.Url,
  })
}

export function normalizeBingUrlTrafficInfo(value: unknown): Result<BingUrlTrafficInfo, 'invalid-payload'> {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.Clicks)
    || !isNonNegativeInteger(value.Impressions)
    || typeof value.IsPage !== 'boolean'
    || typeof value.Url !== 'string') {
    return err('invalid-payload')
  }

  return ok({
    clicks: value.Clicks,
    impressions: value.Impressions,
    isPage: value.IsPage,
    url: value.Url,
  })
}

export function normalizeBingPageStats(value: unknown): Result<BingPageStats, 'invalid-payload'> {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.AvgClickPosition)
    || !isNonNegativeInteger(value.AvgImpressionPosition)
    || !isNonNegativeInteger(value.Clicks)
    || !isNonNegativeInteger(value.Impressions)
    || typeof value.Query !== 'string') {
    return err('invalid-payload')
  }

  const date = parseBingDate(value.Date)
  if (!date.ok || !date.value)
    return err('invalid-payload')

  return ok({
    averageClickPosition: value.AvgClickPosition,
    averageImpressionPosition: value.AvgImpressionPosition,
    clicks: value.Clicks,
    date: date.value,
    impressions: value.Impressions,
    query: value.Query,
  })
}

const CRAWL_ISSUES: Readonly<Record<number, BingCrawlIssue>> = {
  0: 'none',
  1: '301',
  2: '302',
  4: '4xx',
  8: '5xx',
  16: 'blocked-by-robots-txt',
  32: 'contains-malware',
  64: 'important-url-blocked-by-robots-txt',
  128: 'dns-errors',
  256: 'timeout-errors',
}

export function normalizeBingCrawlIssue(value: unknown): Result<BingUrlWithCrawlIssues, 'invalid-payload'> {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.HttpCode)
    || !isNonNegativeInteger(value.InLinks)
    || !isNonNegativeInteger(value.Issues)
    || typeof value.Url !== 'string') {
    return err('invalid-payload')
  }

  return ok({
    httpCode: value.HttpCode,
    inLinks: value.InLinks,
    issue: CRAWL_ISSUES[value.Issues] ?? 'unknown',
    rawIssueCode: value.Issues,
    url: value.Url,
  })
}

export function normalizeBingIndexingEvidence(
  info: BingUrlInfo | null,
  url: string,
  observedAt: Date,
): Result<BingIndexingEvidence, BingEvidenceError> {
  if (!info) {
    return ok({
      _tag: 'UnknownEvidence',
      observedAt: observedAt.toISOString(),
      reason: 'not-observed',
      searchEngine: 'bing',
      url,
    })
  }

  const hasNoCrawlEvidence = !info.discoveryDate
    && !info.lastCrawledDate
    && info.httpStatus === 0
    && info.documentSize === 0
    && info.anchorCount === 0
    && info.totalChildUrlCount === 0
  if (hasNoCrawlEvidence) {
    return ok({
      _tag: 'UnknownEvidence',
      observedAt: observedAt.toISOString(),
      reason: 'not-discovered',
      searchEngine: 'bing',
      url,
    })
  }

  if (!info.isPage) {
    return err({
      _tag: 'UnsupportedEvidence',
      reason: 'not-a-page',
      url,
    })
  }

  return ok({
    _tag: 'CrawlEvidence',
    anchorCount: info.anchorCount,
    ...(info.discoveryDate ? { discoveryDate: info.discoveryDate } : {}),
    documentSize: info.documentSize,
    httpStatus: info.httpStatus,
    ...(info.lastCrawledDate ? { lastCrawledDate: info.lastCrawledDate } : {}),
    observedAt: observedAt.toISOString(),
    rawStatus: info.httpStatus,
    searchEngine: 'bing',
    totalChildUrlCount: info.totalChildUrlCount,
    uncertaintyReason: 'indexed-verdict-unavailable',
    url,
  })
}
