import type { CallOptions, GoogleSearchConsoleClient } from '../core/client'
import type { UrlInspectionResult as GscUrlInspectionResult } from '../core/types'
import { hasGscReadScope } from '../core/scopes'
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
  /** @deprecated Retained for historical storage rows. */
  mobileVerdict: string | null
  /** @deprecated Retained for historical storage rows. */
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
  options?: CallOptions,
): Promise<ParsedIndexingResult> {
  const response = await client.inspect(siteUrl, inspectionUrl, options)
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

/** Maximum parallel URL Inspection requests started by the settled flat batch helper. */
export const MAX_FLAT_INSPECTION_BATCH_CONCURRENCY = 10

export type InspectUrlFlatSettledResult
  = | { url: string, status: 'fulfilled', value: ParsedIndexingResult }
    | { url: string, status: 'rejected', reason: unknown }

export interface BatchInspectUrlsFlatSettledOptions extends CallOptions {
  /** Delay after each request handled by a worker. Defaults to 200ms. */
  delayMs?: number
  /** Number of workers. Defaults to 1 and is capped at {@link MAX_FLAT_INSPECTION_BATCH_CONCURRENCY}. */
  concurrency?: number
  onProgress?: (result: InspectUrlFlatSettledResult, index: number, total: number) => void
}

/**
 * Inspect URLs into the flat storage shape without failing the whole batch
 * when one URL fails. Results retain input order and include each URL so
 * callers can persist successes and classify individual failures safely.
 */
export async function batchInspectUrlsFlatSettled(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  urls: readonly string[],
  options: BatchInspectUrlsFlatSettledOptions = {},
): Promise<InspectUrlFlatSettledResult[]> {
  const requestedConcurrency = Math.trunc(options.concurrency ?? 1)
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(requestedConcurrency, MAX_FLAT_INSPECTION_BATCH_CONCURRENCY))
    : 1

  return runSequentialBatch(
    [...urls],
    async (url): Promise<InspectUrlFlatSettledResult> => {
      try {
        const value = await inspectUrlFlat(client, siteUrl, url, { signal: options.signal })
        return { url, status: 'fulfilled', value }
      }
      catch (reason) {
        return { url, status: 'rejected', reason }
      }
    },
    {
      delayMs: options.delayMs ?? 200,
      concurrency,
      onProgress: options.onProgress,
    },
  )
}

// --- Re-check scheduling ---------------------------------------------------
// Priority/cadence policy for re-inspecting a URL based on its current verdict
// and, when supplied, its recent search value.

export type LegacyInspectionPriority = 'high' | 'medium' | 'low'
export type ValueWeightedInspectionPriority = 'critical' | 'high' | 'elevated' | 'normal' | 'dormant'
export type InspectionPriority = LegacyInspectionPriority | ValueWeightedInspectionPriority

/**
 * Derive the recheck tier.
 *
 * Omitting `impressions28d` preserves the verdict-only policy. Consumers own
 * signal freshness and the 90-day stable-zero guard, and should omit the value
 * until those conditions make a dormant classification safe.
 */
export function getNextCheckPriority(
  result: Pick<ParsedIndexingResult, 'verdict'>,
): LegacyInspectionPriority
export function getNextCheckPriority(
  result: Pick<ParsedIndexingResult, 'verdict'>,
  impressions28d: undefined,
): LegacyInspectionPriority
export function getNextCheckPriority(
  result: Pick<ParsedIndexingResult, 'verdict'>,
  impressions28d: number,
): ValueWeightedInspectionPriority
export function getNextCheckPriority(
  result: Pick<ParsedIndexingResult, 'verdict'>,
  impressions28d: number | undefined,
): InspectionPriority
export function getNextCheckPriority(
  result: Pick<ParsedIndexingResult, 'verdict'>,
  impressions28d?: number,
): InspectionPriority {
  if (impressions28d === undefined) {
    if (!result.verdict || result.verdict === 'VERDICT_UNSPECIFIED')
      return 'medium'
    if (result.verdict === 'FAIL' || result.verdict === 'PARTIAL' || result.verdict === 'NEUTRAL')
      return 'high'
    if (result.verdict === 'PASS')
      return 'low'
    return 'medium'
  }

  if (result.verdict !== 'PASS')
    return 'high'
  if (impressions28d >= 1000)
    return 'critical'
  if (impressions28d >= 100)
    return 'elevated'
  if (impressions28d >= 1)
    return 'normal'
  return 'dormant'
}

/** Next-check unix seconds for a given priority. */
export function getNextCheckAfter(priority: InspectionPriority): number {
  const now = Math.floor(Date.now() / 1000)
  switch (priority) {
    case 'critical':
    case 'high':
      return now + 7 * 86400
    case 'elevated':
    case 'medium':
      return now + 14 * 86400
    case 'low':
    case 'normal':
      return now + 30 * 86400
    case 'dormant':
      return now + 120 * 86400
  }
}

// --- Eligibility -----------------------------------------------------------
// "Can this user actually call the URL Inspection API for this property?"
// Two gates: the OAuth grant must include a Search Console scope, AND the user's
// GSC permission on the property must be one of the inspection-allowed levels.

// Any verified user can call URL inspection; only siteUnverifiedUser is blocked.
const INSPECTION_ALLOWED_PERMISSIONS = new Set(['siteOwner', 'siteFullUser', 'siteRestrictedUser'])

export function canUseUrlInspection(permissionLevel: string | null | undefined): boolean {
  return !!permissionLevel && INSPECTION_ALLOWED_PERMISSIONS.has(permissionLevel)
}

function grantedScopeList(scopes: string | null | undefined): string[] {
  return scopes?.split(/\s+/).map(s => s.trim()).filter(Boolean) ?? []
}

export type IndexingIneligibleReason = 'missing_gsc_read_scope' | 'insufficient_gsc_permission'

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
  if (!hasGscReadScope(grantedScopes)) {
    return {
      indexingEligible: false,
      indexingIneligibleReason: 'missing_gsc_read_scope',
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
