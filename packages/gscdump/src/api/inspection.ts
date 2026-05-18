import type { GoogleSearchConsoleClient } from '../core/client'
import type { UrlInspectionResult as GscUrlInspectionResult } from '../core/types'
import { hasIndexingScope } from '../core/scopes'
import { runSequentialBatch } from './batch'

export interface InspectUrlResult {
  url: string
  inspection?: GscUrlInspectionResult
  isIndexed: boolean
}

/**
 * Inspects a URL in Google Search Console to check its indexing status.
 */
export async function inspectUrl(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  inspectionUrl: string,
): Promise<{ inspection: GscUrlInspectionResult | undefined, isIndexed: boolean }> {
  const response = await client.inspect(siteUrl, inspectionUrl)
  const inspection = response.inspectionResult
  const isIndexed = inspection?.indexStatusResult?.verdict === 'PASS'
  return { inspection, isIndexed }
}

/**
 * Batch inspect multiple URLs with rate limiting.
 * Returns inspection results for each URL.
 */
export async function batchInspectUrls(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  urls: string[],
  options: {
    delayMs?: number
    concurrency?: number
    onProgress?: (result: InspectUrlResult, index: number, total: number) => void
  } = {},
): Promise<InspectUrlResult[]> {
  const { delayMs = 200, concurrency, onProgress } = options
  return runSequentialBatch(
    urls,
    async (url) => {
      const { inspection, isIndexed } = await inspectUrl(client, siteUrl, url)
      return { url, inspection, isIndexed } satisfies InspectUrlResult
    },
    { delayMs, concurrency, onProgress },
  )
}

// --- Storage-shape projection ----------------------------------------------
// Flat `ParsedIndexingResult` projection of `InspectUrlIndexResponse` for
// callers that persist inspection rows. Pulls the index/mobile/rich-results
// blocks out and stringifies array fields so the result maps cleanly to a
// single SQL row.

export interface ParsedIndexingResult {
  url: string
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  robotsTxtState: string | null
  pageFetchState: string | null
  lastCrawlTime: string | null
  crawlingUserAgent: string | null
  userCanonical: string | null
  googleCanonical: string | null
  sitemaps: string | null
  referringUrls: string | null
  mobileVerdict: string | null
  mobileIssues: string | null
  richResultsVerdict: string | null
  richResultsItems: string | null
  ampVerdict: string | null
  ampUrl: string | null
  ampIndexingState: string | null
  ampIndexStatusVerdict: string | null
  ampRobotsTxtState: string | null
  ampPageFetchState: string | null
  ampLastCrawlTime: string | null
  ampIssues: string | null
  inspectionResultLink: string | null
}

export async function inspectUrlFlat(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  inspectionUrl: string,
): Promise<ParsedIndexingResult> {
  const response = await client.inspect(siteUrl, inspectionUrl)
  const inspection = response.inspectionResult
  const index = inspection?.indexStatusResult
  const mobile = inspection?.mobileUsabilityResult
  const rich = inspection?.richResultsResult
  const amp = inspection?.ampResult
  return {
    url: inspectionUrl,
    verdict: index?.verdict ?? null,
    coverageState: index?.coverageState ?? null,
    indexingState: index?.indexingState ?? null,
    robotsTxtState: index?.robotsTxtState ?? null,
    pageFetchState: index?.pageFetchState ?? null,
    lastCrawlTime: index?.lastCrawlTime ?? null,
    crawlingUserAgent: index?.crawledAs ?? null,
    userCanonical: index?.userCanonical ?? null,
    googleCanonical: index?.googleCanonical ?? null,
    sitemaps: index?.sitemap?.length ? JSON.stringify(index.sitemap) : null,
    referringUrls: index?.referringUrls?.length ? JSON.stringify(index.referringUrls) : null,
    mobileVerdict: mobile?.verdict ?? null,
    mobileIssues: mobile?.issues?.length ? JSON.stringify(mobile.issues) : null,
    richResultsVerdict: rich?.verdict ?? null,
    richResultsItems: rich?.detectedItems?.length ? JSON.stringify(rich.detectedItems) : null,
    ampVerdict: amp?.verdict ?? null,
    ampUrl: amp?.ampUrl ?? null,
    ampIndexingState: amp?.indexingState ?? null,
    ampIndexStatusVerdict: amp?.ampIndexStatusVerdict ?? null,
    ampRobotsTxtState: amp?.robotsTxtState ?? null,
    ampPageFetchState: amp?.pageFetchState ?? null,
    ampLastCrawlTime: amp?.lastCrawlTime ?? null,
    ampIssues: amp?.issues?.length ? JSON.stringify(amp.issues) : null,
    inspectionResultLink: inspection?.inspectionResultLink ?? null,
  }
}

// --- Re-check scheduling ---------------------------------------------------
// Priority/cadence policy for re-inspecting a URL based on its current
// verdict. Non-indexed pages are checked more frequently to catch the
// transition; indexed pages back off to a monthly cadence.

export type InspectionPriority = 'high' | 'medium' | 'low'

export function getNextCheckPriority(result: Pick<ParsedIndexingResult, 'verdict'>): InspectionPriority {
  if (!result.verdict || result.verdict === 'VERDICT_UNSPECIFIED')
    return 'medium'
  if (result.verdict === 'FAIL' || result.verdict === 'PARTIAL' || result.verdict === 'NEUTRAL')
    return 'high'
  if (result.verdict === 'PASS')
    return 'low'
  return 'medium'
}

/** Next-check unix seconds for a given priority. */
export function getNextCheckAfter(priority: InspectionPriority): number {
  const now = Math.floor(Date.now() / 1000)
  switch (priority) {
    case 'high': return now + 7 * 86400
    case 'medium': return now + 14 * 86400
    case 'low': return now + 30 * 86400
  }
}

// --- Eligibility -----------------------------------------------------------
// "Can this user actually call the URL Inspection API for this property?"
// Two gates: the OAuth grant must include the indexing scope, AND the user's
// GSC permission on the property must be one of the inspection-allowed levels.

// Any verified user can call URL inspection; only siteUnverifiedUser is blocked.
const INSPECTION_ALLOWED_PERMISSIONS = new Set(['siteOwner', 'siteFullUser', 'siteRestrictedUser'])

export function canUseUrlInspection(permissionLevel: string | null | undefined): boolean {
  return !!permissionLevel && INSPECTION_ALLOWED_PERMISSIONS.has(permissionLevel)
}

export function grantedScopeList(scopes: string | null | undefined): string[] {
  return scopes?.split(/\s+/).map(s => s.trim()).filter(Boolean) ?? []
}

export type IndexingIneligibleReason = 'missing_indexing_scope' | 'insufficient_gsc_permission'

export interface IndexingEligibility {
  indexingEligible: boolean
  indexingIneligibleReason?: IndexingIneligibleReason
  indexingPermissionLevel?: string | null
  grantedScopes?: string[]
}

export function getIndexingEligibility(
  grantedScopes: string | null | undefined,
  permissionLevel: string | null | undefined,
): IndexingEligibility {
  const scopes = grantedScopeList(grantedScopes)
  if (!hasIndexingScope(grantedScopes)) {
    return {
      indexingEligible: false,
      indexingIneligibleReason: 'missing_indexing_scope',
      indexingPermissionLevel: permissionLevel ?? null,
      grantedScopes: scopes,
    }
  }
  if (!canUseUrlInspection(permissionLevel)) {
    return {
      indexingEligible: false,
      indexingIneligibleReason: 'insufficient_gsc_permission',
      indexingPermissionLevel: permissionLevel ?? null,
      grantedScopes: scopes,
    }
  }
  return {
    indexingEligible: true,
    indexingPermissionLevel: permissionLevel ?? null,
    grantedScopes: scopes,
  }
}
