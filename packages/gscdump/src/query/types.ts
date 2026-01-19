import type { Country, Device } from './constants'

// Dimension value mapping
export interface DimensionValueMap {
  query: string
  page: string
  country: Country
  device: Device
  searchAppearance: string
  date: string
}

export type Dimension = keyof DimensionValueMap

// Branded column type
declare const ColumnBrand: unique symbol
export interface Column<D extends Dimension> {
  readonly [ColumnBrand]: D
  readonly dimension: D
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
  dimension: Dimension
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
  filters: Filter<any>[]
  siteUrl?: string
  rowLimit?: number
}
