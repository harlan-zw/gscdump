import type { Column, Dimension, QueryParam, QueryParamName } from './types'

function createColumn<D extends Dimension>(dimension: D): Column<D> {
  return { dimension } as Column<D>
}

function createQueryParam<P extends QueryParamName>(param: P): QueryParam<P> {
  return { param } as QueryParam<P>
}

// Groupable dimensions
export const page = createColumn('page')
export const query = createColumn('query')
export const device = createColumn('device')
export const country = createColumn('country')
export const searchAppearance = createColumn('searchAppearance')
export const date = createColumn('date')

// Non-groupable query params (top-level filters)
export const searchType = createQueryParam('searchType')
