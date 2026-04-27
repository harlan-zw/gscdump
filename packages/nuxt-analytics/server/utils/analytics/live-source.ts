// Live GSC API query source. Wraps `@gscdump/analysis`'s
// `createGscApiQuerySource` with a host-supplied access-token getter so
// token refresh stays the host's concern (encryption, partner credentials,
// session lifetime — none of which the layer should know about).
//
// Used by:
//   - free-tier flows (no engine data → everything goes live)
//   - pro flows when a query's date range falls outside the synced window
//     and is GSC-answerable (via `createCompositeSource`)

import type { AnalysisQuerySource } from '@gscdump/analysis'
import type { GoogleSearchConsoleClient } from 'gscdump'
import type { BuilderState } from 'gscdump/query'
import { createGscApiQuerySource } from '@gscdump/analysis'
import { googleSearchConsole } from 'gscdump'
import { extractMetricFilters, extractSpecialOperatorFilters } from 'gscdump/query'

// Dimensions the GSC API can't produce (engine-derived).
const PRO_ONLY_DIMENSIONS = new Set<string>(['queryCanonical', 'page_keywords'])

export function canProxyToGsc(state: BuilderState): boolean {
  if (state.dimensions.some(d => PRO_ONLY_DIMENSIONS.has(d)))
    return false
  if (extractMetricFilters(state.filter).length > 0)
    return false
  if (extractSpecialOperatorFilters(state.filter).length > 0)
    return false
  return true
}

export interface CreateLiveGscSourceOptions {
  /** GSC property URL (e.g. `sc-domain:example.com` or `https://example.com/`). */
  siteUrl: string
  /**
   * Returns a valid GSC access token. Called lazily on first query so refresh
   * cost is paid only when the source actually runs. Host owns refresh logic.
   */
  getAccessToken: () => Promise<string>
}

export function createLiveGscSource(opts: CreateLiveGscSourceOptions): AnalysisQuerySource {
  let clientPromise: Promise<GoogleSearchConsoleClient> | null = null
  function getClient(): Promise<GoogleSearchConsoleClient> {
    if (!clientPromise)
      clientPromise = opts.getAccessToken().then(accessToken => googleSearchConsole({ accessToken }))
    return clientPromise
  }

  return {
    name: 'gsc-api',
    capabilities: { regex: true, multiDataset: false, comparisonJoin: false, windowTotals: false },
    async queryRows(state: BuilderState) {
      const client = await getClient()
      return createGscApiQuerySource({ client, siteUrl: opts.siteUrl }).queryRows(state)
    },
  }
}
