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
import type { BuilderState, Filter } from 'gscdump/query'
import { googleSearchConsole } from 'gscdump'
import { and, normalizeBuilderStateResult, page, queryErrors, queryErrorToException, regex } from 'gscdump/query'
import { createGscApiQuerySource } from './source'
import { hostPagePattern } from './sync-slice'

// Dimensions the GSC API can't produce (engine-derived).
const PRO_ONLY_DIMENSIONS = new Set<string>(['queryCanonical', 'page_keywords'])

function hasMatchingFilter(filter: Filter<any> | undefined, matches: (dimension: string) => boolean): boolean {
  return !!filter && (filter._filters.some(leaf => matches(leaf.dimension))
    || (filter._nestedGroups ?? []).some(group => hasMatchingFilter(group, matches)))
}

// Classifies raw routing inputs, so both the builder shape and the partner
// wire shape (`{ type, filters: [{ type, column, ... }] }`) parse here. A
// state that fails validation is never proxyable: it can't be trusted to
// reach the live API.
export function canProxyToGsc(state: BuilderState): boolean {
  const parsed = normalizeBuilderStateResult(state)
  if (!parsed.ok)
    return false
  const normalized = parsed.value
  return !hasMatchingFilter(normalized.prefilter, () => true)
    && !normalized.dimensions.some(d => PRO_ONLY_DIMENSIONS.has(d))
    && !hasMatchingFilter(normalized.filter, dimension => PRO_ONLY_DIMENSIONS.has(dimension))
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
  /**
   * Scope every read to one exact host with the same `page` filter the sync
   * applies. Set it whenever the sync filters, so live and stored rows count
   * impressions the same way.
   */
  pageScope?: { host: string }
}

function withSearchType(state: BuilderState, searchType: EngineSearchType): BuilderState {
  return state.searchType ? state : { ...state, searchType }
}

// Normalizes first so a wire-shaped filter composes like a builder one. A
// requested by-property or showcase counting cannot hold under a page filter,
// so it fails as the typed query error GSC's own rule would raise.
function withPageScope(state: BuilderState, host: string): BuilderState {
  const parsed = normalizeBuilderStateResult(state)
  if (!parsed.ok)
    throw queryErrorToException(parsed.error)
  const base = parsed.value
  if (base.aggregationType === 'byProperty')
    throw queryErrorToException(queryErrors.byPropertyNotAllowedWithPage())
  if (base.aggregationType === 'byNewsShowcasePanel')
    throw queryErrorToException(queryErrors.byNewsShowcaseNotAllowedWithPage())
  const scope = regex(page, hostPagePattern(host))
  return { ...base, filter: base.filter ? and(base.filter as Filter<any>, scope) : scope }
}

export function createLiveGscSource(opts: CreateLiveGscSourceOptions): AnalysisQuerySource {
  let clientPromise: Promise<GoogleSearchConsoleClient> | null = null
  function getClient(): Promise<GoogleSearchConsoleClient> {
    if (!clientPromise) {
      clientPromise = opts.getAccessToken().then(accessToken =>
        opts.createClient?.(accessToken) ?? googleSearchConsole({ accessToken }),
      ).catch((error: unknown) => {
        // A failed token refresh or client setup must not poison later queries.
        clientPromise = null
        throw error
      })
    }
    return clientPromise
  }

  return {
    name: 'gsc-api',
    kind: 'live',
    capabilities: { regex: true, multiDataset: false, comparisonJoin: false, windowTotals: false },
    async queryRows(state: BuilderState) {
      const client = await getClient()
      const typed = opts.searchType !== undefined ? withSearchType(state, opts.searchType) : state
      const scopedState = opts.pageScope ? withPageScope(typed, opts.pageScope.host) : typed
      return createGscApiQuerySource({ client, siteUrl: opts.siteUrl }).queryRows(scopedState)
    },
  }
}
