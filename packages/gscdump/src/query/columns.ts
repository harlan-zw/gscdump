import type { Column, Dimension, Metric, MetricColumn, QueryParam, QueryParamName } from './types'

function createColumn<D extends Dimension>(dimension: D): Column<D> {
  return { dimension } as Column<D>
}

function createMetricColumn<M extends Metric>(metric: M): MetricColumn<M> {
  return { metric } as MetricColumn<M>
}

function createQueryParam<P extends QueryParamName>(param: P): QueryParam<P> {
  return { param } as QueryParam<P>
}

// Groupable dimensions
export const page = createColumn('page')
export const query = createColumn('query')
export const queryCanonical = createColumn('queryCanonical')
export const device = createColumn('device')
export const country = createColumn('country')
export const searchAppearance = createColumn('searchAppearance')
export const date = createColumn('date')
export const hour = createColumn('hour')

// Metric columns (aggregated, not groupable)
export const clicks = createMetricColumn('clicks')
export const impressions = createMetricColumn('impressions')
export const ctr = createMetricColumn('ctr')
export const position = createMetricColumn('position')

// Non-groupable query params (top-level filters)
export const searchType = createQueryParam('searchType')
