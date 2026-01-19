import type { GoogleSearchConsoleClient } from '../core/client'
import type { SearchAnalyticsQuery, SearchAnalyticsResponse } from '../core/types'
import type { BuilderState, Dimension, Filter, GSCResult } from './types'
import { resolveToBody } from './resolver'

export interface GSCQueryBuilder<
  D extends Dimension[] = [],
  C = object,
> {
  select: <T extends Dimension[]>(...dims: T) => GSCQueryBuilder<T, C>

  where: <F extends Filter<any>>(
    filter: F,
  ) => GSCQueryBuilder<D, C & F['_constraints']>

  siteUrl: (url: string) => GSCQueryBuilder<D, C>

  limit: (n: number) => GSCQueryBuilder<D, C>

  execute: (client: GoogleSearchConsoleClient) => Promise<GSCResult<D, C>>

  toBody: () => SearchAnalyticsQuery

  /** Expose internal state for analysis functions to merge with */
  getState: () => BuilderState
}

function transformResponse<D extends Dimension[], C>(
  response: SearchAnalyticsResponse,
  dimensions: Dimension[],
): GSCResult<D, C> {
  return {
    rows: (response.rows ?? []).map((row) => {
      const result: any = {
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      }
      dimensions.forEach((dim, i) => {
        result[dim] = row.keys?.[i]
      })
      return result
    }),
  }
}

function createBuilder<D extends Dimension[], C>(
  state: BuilderState,
): GSCQueryBuilder<D, C> {
  return {
    select<T extends Dimension[]>(...dims: T) {
      return createBuilder<T, C>({ ...state, dimensions: dims })
    },

    where<F extends Filter<any>>(filter: F) {
      return createBuilder<D, C & F['_constraints']>({
        ...state,
        filters: [...state.filters, filter],
      })
    },

    siteUrl(url: string) {
      return createBuilder<D, C>({ ...state, siteUrl: url })
    },

    limit(n: number) {
      return createBuilder<D, C>({ ...state, rowLimit: n })
    },

    async execute(client: GoogleSearchConsoleClient): Promise<GSCResult<D, C>> {
      const body = resolveToBody(state)
      const response = await client.searchAnalytics.query(state.siteUrl!, body)
      return transformResponse<D, C>(response, state.dimensions)
    },

    toBody() {
      return resolveToBody(state)
    },

    getState() {
      return { ...state }
    },
  }
}

// Entry point
export const gsc: GSCQueryBuilder<[], object> = createBuilder({
  dimensions: [],
  filters: [],
})
