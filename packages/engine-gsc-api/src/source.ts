import type { AnalysisQuerySource, QueryRow } from '@gscdump/engine/source'
import type { GoogleSearchConsoleClient } from 'gscdump/api'
import type { BuilderState, GSCQueryBuilder } from 'gscdump/query'

import type { PlannerCapabilities } from 'gscdump/query/plan'

import { assertDimensionsSupported, getFilterDimensions } from '@gscdump/engine/resolver'
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
      // The live source performs ordering, metric/special filters, offset and
      // limit after row collection. Do not let the API client page the candidate
      // set first, or those post-processing steps operate on a truncated window.
      const apiState: BuilderState = { ...state, rowLimit: undefined, startRow: undefined }
      const rows = await collectRows(client.query(siteUrl, builderFromState(apiState)))
      return applyBuilderStatePostProcessing(rows as QueryRow[], state)
    },
  }
}
