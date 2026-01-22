import type { Country, Device, SearchType } from './constants'

// Dimension value mapping (groupable dimensions)
export interface DimensionValueMap {
  query: string
  page: string
  country: Country
  device: Device
  searchAppearance: string
  date: string
}

export type Dimension = keyof DimensionValueMap

// Query param value mapping (non-groupable, top-level query params)
export interface QueryParamValueMap {
  searchType: SearchType
}

export type QueryParamName = keyof QueryParamValueMap

// Branded column type (for groupable dimensions)
declare const ColumnBrand: unique symbol
export interface Column<D extends Dimension> {
  readonly [ColumnBrand]: D
  readonly dimension: D
}

// Branded query param type (for non-groupable top-level params)
declare const QueryParamBrand: unique symbol
export interface QueryParam<P extends QueryParamName> {
  readonly [QueryParamBrand]: P
  readonly param: P
}

// Filter operator types for GSC API
export type FilterOperator
  = | 'equals'
    | 'notEquals'
    | 'contains'
    | 'notContains'
    | 'includingRegex'
    | 'excludingRegex'

// Date comparison operators (resolved to startDate/endDate)
export type DateOperator = 'gte' | 'gt' | 'lte' | 'lt' | 'between'

// Internal filter representation
export interface InternalFilter {
  dimension: Dimension | QueryParamName
  operator: FilterOperator | DateOperator
  expression: string
  expression2?: string // for between operator
}

// Branded filter type with constraint tracking
declare const FilterBrand: unique symbol
export interface Filter<C = object> {
  readonly [FilterBrand]: true
  readonly _constraints: C
  readonly _filters: InternalFilter[]
  readonly _nestedGroups?: Filter<any>[] // Preserve nested or/and groups
  readonly _groupType?: 'and' | 'or'
}

// Merge constraints utility (for and())
export type MergeConstraints<F extends Filter<any>[]> = UnionToIntersection<
  F[number]['_constraints']
>

// UnionToIntersection helper
export type UnionToIntersection<U>
  = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never

// Result types
export interface GSCResult<D extends Dimension[], C> {
  rows: Array<GSCRow<D, C>>
}

export type GSCRow<D extends Dimension[], C> = {
  [K in D[number]]: K extends keyof C ? C[K] : DimensionValueMap[K]
} & {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

// Internal builder state
export interface BuilderState {
  dimensions: Dimension[]
  filter?: Filter<any>
  rowLimit?: number
  startRow?: number
}
