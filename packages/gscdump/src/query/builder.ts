import type { GscAggregationType, GscDataState, GscSearchAnalyticsRequest, GscSearchType } from '../contracts'
import type { BuilderState, Column, Dimension, Filter, Metric, MetricColumn } from './types'
import { resolveToBody } from './resolver'

// A selectable column is either a dimension column or a metric column
export type SelectableColumn = Column<Dimension> | MetricColumn<Metric>

// Orderable column: metric columns or date dimension
export type OrderableColumn = MetricColumn<Metric> | Column<'date'>

// Extract dimensions from a mixed selection
type ExtractDimensions<T extends SelectableColumn[]> = {
  [K in keyof T]: T[K] extends Column<infer D> ? D : never
}[number] extends infer U ? Exclude<U, never>[] : never

export interface GSCQueryBuilder<
  D extends Dimension[] = [],
  C = object,
> {
  select: {
    // Overload 1: string dimension names (backwards compat)
    <T extends Dimension[]>(...dims: T): GSCQueryBuilder<T, C>
    // Overload 2: mixed column objects (dimensions + metrics)
    <T extends SelectableColumn[]>(...cols: T): GSCQueryBuilder<ExtractDimensions<T> & Dimension[], C>
  }
  where: <F extends Filter<any>>(filter: F) => GSCQueryBuilder<D, C & F['_constraints']>
  prefilter: <F extends Filter<any>>(filter: F) => GSCQueryBuilder<D, C>
  orderBy: (col: OrderableColumn, dir: 'asc' | 'desc') => GSCQueryBuilder<D, C>
  limit: (n: number) => GSCQueryBuilder<D, C>
  offset: (n: number) => GSCQueryBuilder<D, C>
  dataState: (state: GscDataState) => GSCQueryBuilder<D, C>
  aggregationType: (type: GscAggregationType) => GSCQueryBuilder<D, C>
  /** GSC search corpus (`type` on the wire). Equivalent to filtering by `searchType`. */
  type: (t: GscSearchType) => GSCQueryBuilder<D, C>
  toBody: () => GscSearchAnalyticsRequest
  getState: () => BuilderState
}

function isDimensionString(v: unknown): v is Dimension {
  return typeof v === 'string'
}

function isMetricColumn(v: unknown): v is MetricColumn<Metric> {
  return typeof v === 'object' && v !== null && 'metric' in v
}

function isDimensionColumn(v: unknown): v is Column<Dimension> {
  return typeof v === 'object' && v !== null && 'dimension' in v && !('metric' in v)
}

function createBuilder<D extends Dimension[], C>(state: BuilderState): GSCQueryBuilder<D, C> {
  return {
    select(...args: any[]) {
      const dimensions: Dimension[] = []
      const metrics: Metric[] = []

      for (const arg of args) {
        if (isDimensionString(arg)) {
          dimensions.push(arg)
        }
        else if (isDimensionColumn(arg)) {
          dimensions.push(arg.dimension)
        }
        else if (isMetricColumn(arg)) {
          metrics.push(arg.metric)
        }
      }

      return createBuilder({
        ...state,
        dimensions,
        metrics: metrics.length > 0 ? metrics : undefined,
      }) as any
    },

    where<F extends Filter<any>>(filter: F) {
      return createBuilder<D, C & F['_constraints']>({
        ...state,
        filter,
      })
    },

    prefilter<F extends Filter<any>>(filter: F) {
      return createBuilder<D, C>({
        ...state,
        prefilter: filter,
      })
    },

    orderBy(col: OrderableColumn, dir: 'asc' | 'desc') {
      const column = isMetricColumn(col) ? col.metric : col.dimension
      return createBuilder<D, C>({
        ...state,
        orderBy: { column, dir },
      })
    },

    limit(n: number) {
      return createBuilder<D, C>({ ...state, rowLimit: n })
    },

    offset(n: number) {
      return createBuilder<D, C>({ ...state, startRow: n })
    },

    dataState(s: GscDataState) {
      return createBuilder<D, C>({ ...state, dataState: s })
    },

    aggregationType(t: GscAggregationType) {
      return createBuilder<D, C>({ ...state, aggregationType: t })
    },

    type(t: GscSearchType) {
      return createBuilder<D, C>({ ...state, searchType: t as BuilderState['searchType'] })
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
