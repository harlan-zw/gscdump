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
import type { GoogleSearchConsoleClient } from 'gscdump/api'
import type { BuilderState, Filter } from 'gscdump/query'
import { googleSearchConsole } from 'gscdump/api'
import { normalizeFilter } from 'gscdump/query'
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
  /**
   * GSC `searchType` slice this source is scoped to (`web`, `discover`,
   * `news`, `googleNews`, `image`, `video`). When set, the slice is injected
   * into every outgoing query's filter so the live API returns rows for that
   * slice only. Undefined preserves pre-0.17.1 behaviour (web by default,
   * unless the BuilderState's filter already names a `searchType`).
   */
  searchType?: EngineSearchType
}

// Inject `searchType` as a top-level dimension filter on the state. The
// gscdump query layer's `extractSpecialFilters` pulls it out and lifts it
// onto the request body. If the state already names a different slice, the
// caller's filter wins — same precedence rule as date filters today.
//
// Normalize first so wire-format filters (`{ type, column, from, to }`) become
// `_filters` shape before we splice in the searchType entry. Without this, the
// spread `{ ...existing, _filters: [...] }` produces a hybrid that has BOTH a
// `type` field AND `_filters` — isWireFilter rejects (sees `_filters`),
// normalizeFilter passes it through unchanged, and the date bound (still on
// the wire `type/from/to`) is silently lost downstream.
function withSearchType(state: BuilderState, searchType: EngineSearchType): BuilderState {
  const normalized = normalizeFilter(state.filter as Parameters<typeof normalizeFilter>[0]) as Filter<any> | undefined
  const existingFilters = normalized?._filters ?? []
  const namesSearchType = existingFilters.some(f => f.dimension === 'searchType')
  if (namesSearchType)
    return normalized === state.filter ? state : { ...state, filter: normalized as BuilderState['filter'] }
  const newEntry = { dimension: 'searchType', operator: 'eq' as const, expression: searchType }
  const merged: Filter<any> = normalized
    ? { ...normalized, _filters: [...existingFilters, newEntry as unknown as typeof existingFilters[number]] }
    : { _filters: [newEntry as unknown as Parameters<typeof Object>[0]], _groupType: 'and' } as unknown as Filter<any>
  return { ...state, filter: merged as BuilderState['filter'] }
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
    kind: 'live',
    capabilities: { regex: true, multiDataset: false, comparisonJoin: false, windowTotals: false },
    async queryRows(state: BuilderState) {
      const client = await getClient()
      const scopedState = opts.searchType !== undefined ? withSearchType(state, opts.searchType) : state
      return createGscApiQuerySource({ client, siteUrl: opts.siteUrl }).queryRows(scopedState)
    },
  }
}
