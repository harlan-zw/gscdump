// Live GSC API query source. Wraps `createGscApiQuerySource` with a
// host-supplied access-token getter so token refresh stays the host's concern
// (encryption, partner credentials, session lifetime — none of which this
// package should know about).
//
// Used by host apps:
//   - free-tier flows (no engine data → everything goes live)
//   - pro flows when a query's date range falls outside the synced window
//     and is GSC-answerable (via `createCompositeSource`)

import type { SearchType as EngineSearchType } from '@gscdump/engine'
import type { AnalysisQuerySource } from '@gscdump/engine/source'
import type { GoogleSearchConsoleClient } from 'gscdump'
import type { BuilderState } from 'gscdump/query'
import { googleSearchConsole } from 'gscdump'
import { createGscApiQuerySource } from './source'

// Dimensions the GSC API can't produce (engine-derived).
const PRO_ONLY_DIMENSIONS = new Set<string>(['queryCanonical', 'page_keywords'])

export function canProxyToGsc(state: BuilderState): boolean {
  if (state.dimensions.some(d => PRO_ONLY_DIMENSIONS.has(d)))
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
  /** Optional host client factory (for custom timeouts, fetch, or telemetry). */
  createClient?: (accessToken: string) => GoogleSearchConsoleClient | Promise<GoogleSearchConsoleClient>
  /**
   * GSC `searchType` slice this source is scoped to (`web`, `discover`,
   * `news`, `googleNews`, `image`, `video`). When set, the slice is injected
   * into every outgoing builder state so the live API returns rows for that
   * slice only. An explicit search type already present on the state wins.
   */
  searchType?: EngineSearchType
}

function withSearchType(state: BuilderState, searchType: EngineSearchType): BuilderState {
  return state.searchType ? state : { ...state, searchType }
}

export function createLiveGscSource(opts: CreateLiveGscSourceOptions): AnalysisQuerySource {
  let clientPromise: Promise<GoogleSearchConsoleClient> | null = null
  function getClient(): Promise<GoogleSearchConsoleClient> {
    if (!clientPromise) {
      clientPromise = opts.getAccessToken().then(accessToken =>
        opts.createClient?.(accessToken) ?? googleSearchConsole({ accessToken }),
      )
    }
    return clientPromise
  }

  return {
    name: 'gsc-api',
    kind: 'live',
    capabilities: { regex: true, multiDataset: false, comparisonJoin: false, windowTotals: false },
    async queryRows(state: BuilderState) {
      const client = await getClient()
      const scopedState = opts.searchType !== undefined ? withSearchType(state, opts.searchType) : state
      return createGscApiQuerySource({ client, siteUrl: opts.siteUrl }).queryRows(scopedState)
    },
  }
}
