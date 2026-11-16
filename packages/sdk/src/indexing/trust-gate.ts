// The Trust gate: can a Site's indexing figures be trusted, and is its sitemap alive?
//
// Ported from nuxtseo.com `layers/pro/gsc/shared/trust-gate.ts` and its
// contract in `shared/contracts/trust-gate.ts`.
//
// Setup states come first, so a Site that is not set up never reaches the red
// gate. A lone probe failure never vetoes the figures: the red `broken` state
// needs corroboration, a stale Search Console download or a sitemap collapse.

import type { CurrentSitemapScope, SitemapCollapseState } from '@gscdump/analysis/sitemap-health'
import {
  classifySitemapCollapse,
  compareCurrentSitemapScope as compareSitemapScope,
  SITEMAP_TRUST_COLLAPSE_POLICY,
  sitemapHistoryHasCollapse,
} from '@gscdump/analysis/sitemap-health'

export type { CurrentSitemapScope, SitemapCollapseState }

export type TrustGateState
  = | 'ok' // reachable, or unprobed with nothing wrong: the common path
    | 'unknown' // no probe, and the stored evidence looks broken
    | 'blip' // one failed probe with no corroboration: a warning, not the red gate
    | 'broken' // a failed probe plus corroboration: indexing cannot be confirmed
    | 'no_sitemap' // no sitemap is submitted, or the sitemap answers 404
    | 'not_connected' // Search Console is not connected
    | 'pending' // connected, but inspection or the first sync has no data yet

export interface TrustGate {
  state: TrustGateState
  /** One plain sentence naming the state. */
  reason: string
}

/** States where the figures are degraded, so a panel shows its diagnosis variant. */
export const TRUST_DEGRADED_STATES: ReadonlySet<TrustGateState> = new Set(['unknown', 'blip', 'broken', 'no_sitemap'])

export function isTrustDegraded(state: TrustGateState): boolean {
  return TRUST_DEGRADED_STATES.has(state)
}

/** Search Console downloads a healthy sitemap well within a week. Older than this is stale. */
export const STALE_DOWNLOAD_DAYS = 7

/** One live sitemap probe result. */
export interface SitemapLivenessCheck {
  /** `timeout`: the probe aborted. `error`: a non-2xx response or a network failure. */
  status: 'reachable' | 'timeout' | 'error'
  /** The HTTP status when a response came back. */
  statusCode?: number | null
}

/** One day of a Site's sitemap URL count. */
export interface SitemapCountPoint {
  /** `YYYY-MM-DD` or an ISO timestamp. Only the order matters. */
  date: string
  urlCount: number | null | undefined
}

// The `@gscdump/analysis` helpers read counts newest first. Callers hold dated
// points, and nuxtseo.com passed its oldest-first array straight through, so a
// Site that grew from 4 to 1,000 URLs read as a collapse. These wrappers take
// dated points and order them here, so no caller can pass the wrong order.
function newestFirstCounts(history: readonly SitemapCountPoint[]): Array<number | null | undefined> {
  return history.toSorted((a, b) => b.date.localeCompare(a.date)).map(point => point.urlCount)
}

/** Did the sitemap URL count ever drop below 20% of an earlier peak? */
export function sitemapHistoryCollapsed(history: readonly SitemapCountPoint[]): boolean {
  return sitemapHistoryHasCollapse(newestFirstCounts(history), SITEMAP_TRUST_COLLAPSE_POLICY)
}

/**
 * Compare the latest sitemap count with the earlier high-water mark. The calm
 * state guard of the Indexing overview, distinct from the history check above,
 * which corroborates probe failures.
 */
export function compareCurrentSitemapScope(history: readonly SitemapCountPoint[]): CurrentSitemapScope | null {
  return compareSitemapScope(newestFirstCounts(history), SITEMAP_TRUST_COLLAPSE_POLICY)
}

/**
 * Classify only the latest large sitemap drop. A new drop waits for another
 * count, two low counts in a row persist, and an immediate recovery is a blip.
 */
export function classifyCurrentSitemapDrop(history: readonly SitemapCountPoint[]): SitemapCollapseState {
  return classifySitemapCollapse(newestFirstCounts(history), SITEMAP_TRUST_COLLAPSE_POLICY)
}

export interface TrustGateInput {
  /** Search Console is connected for this Site. */
  connected: boolean
  /**
   * The URL Inspection sample size, never the sitemap total. 0 means Google has
   * inspected nothing yet. `totalUrls` is the fallback when this is absent.
   */
  inspectedCount: number | null
  totalUrls: number | null
  /** The hosted indexing meta status: `pending`, `partial`, or `complete`. */
  indexingStatus: string | null
  /** Search Console reports a submitted sitemap it has not parsed yet. */
  sitemapsPending: boolean
  /** Search Console reports no submitted sitemap. */
  noSitemapsSubmitted: boolean
  /** The live probe. Null when it has not run or is unavailable. */
  liveness: SitemapLivenessCheck | null
  /** The latest Search Console sitemap download, as ISO. Null if never downloaded. */
  lastDownloadedAt: string | null
  /** A sitemap collapse in the window. Corroboration for `broken`. */
  sitemapCollapsed: boolean
  now: Date
}

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 86_400_000
}

export function computeTrustGate(input: TrustGateInput): TrustGate {
  if (!input.connected)
    return { state: 'not_connected', reason: 'Search Console is not connected.' }

  const live = input.liveness

  // No submitted sitemap is a setup issue even before inspection begins. Keep
  // it apart from a missing sitemap file, so a reachable file says "submit".
  if (input.noSitemapsSubmitted) {
    return {
      state: 'no_sitemap',
      reason: live?.status === 'reachable'
        ? 'Sitemap is reachable but not submitted in Search Console.'
        : 'No sitemap is submitted in Search Console.',
    }
  }

  // A sitemap that answers 404 is a missing file, not a broken server.
  if (live?.statusCode === 404)
    return { state: 'no_sitemap', reason: 'No sitemap found at /sitemap.xml.' }

  const inspected = input.inspectedCount ?? input.totalUrls ?? 0
  if (input.sitemapsPending && inspected <= 0)
    return { state: 'pending', reason: 'Sitemap is submitted and waiting for Google to parse it.' }

  if (inspected <= 0)
    return { state: 'pending', reason: 'Google has not inspected any URLs yet.' }

  // `partial` is a healthy mid-sampling state with data, so only other
  // statuses read as still syncing.
  if (input.indexingStatus && input.indexingStatus !== 'complete' && input.indexingStatus !== 'partial')
    return { state: 'pending', reason: 'Search Console data is still syncing.' }

  const staleDownload = input.lastDownloadedAt != null && daysSince(input.lastDownloadedAt, input.now) >= STALE_DOWNLOAD_DAYS
  const corroborated = staleDownload || input.sitemapCollapsed

  if (live && (live.status === 'timeout' || live.status === 'error')) {
    if (corroborated) {
      return {
        state: 'broken',
        reason: live.status === 'timeout'
          ? 'Sitemap is timing out, so indexing cannot be confirmed.'
          : 'Sitemap is unreachable, so indexing cannot be confirmed.',
      }
    }
    return { state: 'blip', reason: 'Could not reach the sitemap just now, retrying.' }
  }

  // No probe, but the stored evidence corroborates a break.
  if (!live && corroborated)
    return { state: 'unknown', reason: 'Indexing cannot be confirmed right now.' }

  return { state: 'ok', reason: 'Google is indexing the pages it discovers.' }
}
