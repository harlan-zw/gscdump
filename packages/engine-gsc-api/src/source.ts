import type { AnalysisQuerySource, QueryRow } from '@gscdump/engine/source'
import type { GoogleSearchConsoleClient } from 'gscdump/api'
import type { BuilderState, GSCQueryBuilder } from 'gscdump/query'

import type { PlannerCapabilities } from 'gscdump/query/plan'

import { assertDimensionsSupported, getFilterDimensions } from '@gscdump/engine/resolver'
import { extractMetricFilters, extractSpecialOperatorFilters } from 'gscdump/query'
import { buildLogicalPlan } from 'gscdump/query/plan'
import { applyBuilderStatePostProcessing } from './post-process'
import { collectRows } from './rollup-synth'

/**
 * Capabilities the live GSC API can satisfy. Regex pushes down via the
 * `INCLUDING_REGEX` / `EXCLUDING_REGEX` filter types; comparison joins and
 * cross-dataset queries do not exist on the wire, and the API does not
 * expose window aggregations. Metric filters and ordering are honored by
 * the source-layer post-process pass after row collection.
 */
export const GSC_API_CAPABILITIES: PlannerCapabilities = {
  regex: true,
  multiDataset: false,
  comparisonJoin: false,
  windowTotals: false,
}

function isMetricDimension(dim: string): dim is 'clicks' | 'impressions' | 'ctr' | 'position' {
  return ['clicks', 'impressions', 'ctr', 'position'].includes(dim)
}

function builderFromState(state: BuilderState): GSCQueryBuilder<any, any> {
  return {
    getState: () => state,
  } as unknown as GSCQueryBuilder<any, any>
}

function canPushDownPagination(state: BuilderState): boolean {
  return !state.orderBy
    && extractMetricFilters(state.filter).length === 0
    && extractSpecialOperatorFilters(state.filter).length === 0
}

export interface GscApiQuerySourceOptions {
  client: GoogleSearchConsoleClient
  siteUrl: string
}

export function createGscApiQuerySource(
  options: GscApiQuerySourceOptions,
): AnalysisQuerySource {
  const { client, siteUrl } = options

  return {
    name: 'gsc-api',
    kind: 'live',
    capabilities: GSC_API_CAPABILITIES,
    async queryRows(state): Promise<QueryRow[]> {
      // Plan-time gating: throws UnsupportedLogicalCapabilityError on filters
      // the API can't honor (e.g. comparison joins). Runs before the network
      // call so consumers fail fast instead of paying for a doomed fetch.
      buildLogicalPlan(state, GSC_API_CAPABILITIES)
      const filterDims = getFilterDimensions(state.filter, isMetricDimension)
      assertDimensionsSupported([...state.dimensions, ...filterDims], 'api', 'gsc-api query source')
      // The live source performs explicit ordering and metric/special filters
      // after row collection. Push pagination down only when those steps are not
      // present, so simple bounded queries do not page the whole GSC result set.
      const pushDownPagination = canPushDownPagination(state)
      const apiState: BuilderState = pushDownPagination
        ? state
        : { ...state, rowLimit: undefined, startRow: undefined }
      const rows = await collectRows(client.query(siteUrl, builderFromState(apiState)))
      const postState = pushDownPagination
        ? { ...state, rowLimit: undefined, startRow: undefined }
        : state
      return applyBuilderStatePostProcessing(rows as QueryRow[], postState)
    },
  }
}
