import type { SearchAnalyticsQuery } from '../core/types'
import type { BuilderState, Dimension, Filter } from './types'
import { resolveToBody } from './resolver'

export interface GSCQueryBuilder<
  D extends Dimension[] = [],
  C = object,
> {
  select: <T extends Dimension[]>(...dims: T) => GSCQueryBuilder<T, C>
  where: <F extends Filter<any>>(filter: F) => GSCQueryBuilder<D, C & F['_constraints']>
  limit: (n: number) => GSCQueryBuilder<D, C>
  offset: (n: number) => GSCQueryBuilder<D, C>
  toBody: () => SearchAnalyticsQuery
  getState: () => BuilderState
}

function createBuilder<D extends Dimension[], C>(state: BuilderState): GSCQueryBuilder<D, C> {
  return {
    select<T extends Dimension[]>(...dims: T) {
      return createBuilder<T, C>({ ...state, dimensions: dims })
    },

    where<F extends Filter<any>>(filter: F) {
      return createBuilder<D, C & F['_constraints']>({
        ...state,
        filter,
      })
    },

    limit(n: number) {
      return createBuilder<D, C>({ ...state, rowLimit: n })
    },

    offset(n: number) {
      return createBuilder<D, C>({ ...state, startRow: n })
    },

    toBody() {
      return resolveToBody(state)
    },

    getState() {
      return { ...state }
    },
  }
}

export const gsc: GSCQueryBuilder<[], object> = createBuilder({
  dimensions: [],
})
