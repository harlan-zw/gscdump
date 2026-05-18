import type { Column, Dimension, DimensionValueMap, Filter, FilterOperator, InternalFilter, MergeConstraints, Metric, MetricColumn, QueryParam, QueryParamName, QueryParamValueMap } from './types'
import { DATE_OPERATORS } from './operator-meta'

function leafFilter(
  dimension: string,
  operator: InternalFilter['operator'],
  expression: string,
  expression2?: string,
): Filter<any> {
  const filter: InternalFilter = { dimension: dimension as InternalFilter['dimension'], operator, expression }
  if (expression2 !== undefined)
    filter.expression2 = expression2
  return {
    _constraints: {},
    _filters: [filter],
  } as Filter<any>
}

function metricOrDimFilter(
  column: Column<any> | MetricColumn<any>,
  metricOp: InternalFilter['operator'],
  dimOp: InternalFilter['operator'],
  expression: string,
  expression2?: string,
): Filter<object> {
  return 'metric' in column
    ? leafFilter(column.metric, metricOp, expression, expression2)
    : leafFilter(column.dimension, dimOp, expression, expression2)
}

// eq - narrows to exact value (works with both Column and QueryParam)
export function eq<D extends Dimension, V extends DimensionValueMap[D]>(
  column: Column<D>,
  value: V,
): Filter<Record<D, V>>
export function eq<P extends QueryParamName, V extends QueryParamValueMap[P]>(
  param: QueryParam<P>,
  value: V,
): Filter<Record<P, V>>
export function eq(
  columnOrParam: Column<any> | QueryParam<any>,
  value: any,
): Filter<any> {
  const key = 'dimension' in columnOrParam ? columnOrParam.dimension : columnOrParam.param
  return leafFilter(key, 'equals', String(value))
}

// ne - excludes value (no narrowing - can't express Exclude in result)
export function ne<D extends Dimension>(
  column: Column<D>,
  value: DimensionValueMap[D],
): Filter<object> {
  return leafFilter(column.dimension, 'notEquals', String(value))
}

// inArray - narrows to union of values
export function inArray<D extends Dimension, V extends DimensionValueMap[D]>(
  column: Column<D>,
  values: readonly V[],
): Filter<Record<D, V>> {
  if (values.length === 0)
    throw new Error(`inArray(${column.dimension}, []) requires at least one value`)
  // GSC doesn't have IN operator - use OR group
  return {
    _constraints: {} as Record<D, V>,
    _filters: values.map(v => ({
      dimension: column.dimension,
      operator: 'equals' as const,
      expression: String(v),
    })),
    _groupType: 'or',
  } as unknown as Filter<Record<D, V>>
}

// contains - pattern match, no narrowing
export function contains<D extends Dimension>(
  column: Column<D>,
  pattern: string,
): Filter<object> {
  return leafFilter(column.dimension, 'contains', pattern)
}

// like - SQL LIKE pattern match. Translates `%` (any chars) and `_` (single
// char) to regex, since GSC has no native LIKE operator. If the pattern has
// no wildcards, falls back to `contains` (cheaper server-side).
export function like<D extends Dimension>(
  column: Column<D>,
  pattern: string,
): Filter<object> {
  if (!/[%_]/.test(pattern))
    return leafFilter(column.dimension, 'contains', pattern)
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = escaped.replace(/%/g, '.*').replace(/_/g, '.')
  return leafFilter(column.dimension, 'includingRegex', regex)
}

// regex - regex match, no narrowing
export function regex<D extends Dimension>(
  column: Column<D>,
  pattern: RegExp | string,
): Filter<object> {
  return leafFilter(column.dimension, 'includingRegex', typeof pattern === 'string' ? pattern : pattern.source)
}

// excludingRegex - regex exclusion, no narrowing
export function notRegex<D extends Dimension>(
  column: Column<D>,
  pattern: RegExp | string,
): Filter<object> {
  return leafFilter(column.dimension, 'excludingRegex', typeof pattern === 'string' ? pattern : pattern.source)
}

// and - merges all constraints, preserves nested OR groups
export function and<F extends Filter<any>[]>(
  ...filters: F
): Filter<MergeConstraints<F>> {
  const flatFilters: Filter<any>['_filters'] = []
  const nestedGroups: Filter<any>[] = []

  for (const f of filters) {
    if (f._groupType === 'or') {
      // Preserve OR groups as nested
      nestedGroups.push(f)
    }
    else {
      // Flatten AND filters
      flatFilters.push(...f._filters)
      // Also preserve any nested groups from this filter
      if (f._nestedGroups) {
        nestedGroups.push(...f._nestedGroups)
      }
    }
  }

  return {
    _constraints: {} as MergeConstraints<F>,
    _filters: flatFilters,
    _nestedGroups: nestedGroups.length > 0 ? nestedGroups : undefined,
    _groupType: 'and',
  } as unknown as Filter<MergeConstraints<F>>
}

// or - no constraint narrowing (result could be any)
// GSC filter groups are flat: each group is either AND or OR with leaf
// filters only. Nested groups (e.g. or(and(a,b), c)) cannot be expressed
// in the API and are rejected here rather than silently flattened.
export function or<F extends Filter<any>[]>(
  ...filters: F
): Filter<object> {
  for (const f of filters) {
    if (f._groupType === 'and' && f._filters.length > 1)
      throw new Error('or() cannot contain a multi-leaf AND group: GSC filter groups do not nest. Restructure as flat OR or split into multiple queries.')
    if (f._nestedGroups && f._nestedGroups.length > 0)
      throw new Error('or() cannot contain nested filter groups: GSC filter groups do not nest.')
    for (const leaf of f._filters) {
      // `date` and `searchType` map to top-level GSC request fields
      // (startDate/endDate/type), which are always AND-applied. Allowing
      // them inside an or() would silently collapse the user's intended
      // OR semantics to AND.
      if (leaf.dimension === 'date')
        throw new Error('or() cannot contain a date filter: GSC date range is a top-level AND-applied request field, not a filter. Apply the date range outside the or() group.')
      if (leaf.dimension === 'searchType')
        throw new Error('or() cannot contain a searchType filter: GSC search type is a top-level AND-applied request field. Use .type() outside the or() group.')
    }
  }
  return {
    _constraints: {},
    _filters: filters.flatMap(f => f._filters),
    _groupType: 'or',
  } as Filter<object>
}

const INVERSIONS: Record<FilterOperator, FilterOperator> = {
  equals: 'notEquals',
  notEquals: 'equals',
  contains: 'notContains',
  notContains: 'contains',
  includingRegex: 'excludingRegex',
  excludingRegex: 'includingRegex',
}

function invertOperator(op: FilterOperator): FilterOperator {
  return INVERSIONS[op]
}

// not - inverts filter, no narrowing. Only dimension operators are
// invertible; date and metric operators have no GSC equivalent inversion
// and are rejected to avoid silently dropping clauses.
export function not<F extends Filter<any>>(filter: F): Filter<object> {
  const inverted: InternalFilter[] = []
  for (const f of filter._filters) {
    if (DATE_OPERATORS.includes(f.operator as any))
      throw new Error(`not() cannot invert date operator "${f.operator}": GSC has no negated date filter.`)
    if (!(f.operator in INVERSIONS))
      throw new Error(`not() cannot invert operator "${f.operator}".`)
    inverted.push({ ...f, operator: invertOperator(f.operator as FilterOperator) })
  }
  return {
    _constraints: {},
    _filters: inverted,
  } as Filter<object>
}

// gte - greater than or equal (date dimension or metric column only —
// GSC's wire operators for non-date dimensions are equals/contains/regex)
export function gte<M extends Metric>(column: MetricColumn<M>, value: number): Filter<object>
export function gte(column: Column<'date'>, value: string): Filter<object>
export function gte(column: Column<any> | MetricColumn<any>, value: any): Filter<object> {
  return metricOrDimFilter(column, 'metricGte', 'gte', String(value))
}

// gt - greater than (date dimension or metric column only)
export function gt<M extends Metric>(column: MetricColumn<M>, value: number): Filter<object>
export function gt(column: Column<'date'>, value: string): Filter<object>
export function gt(column: Column<any> | MetricColumn<any>, value: any): Filter<object> {
  return metricOrDimFilter(column, 'metricGt', 'gt', String(value))
}

// lte - less than or equal (date dimension or metric column only)
export function lte<M extends Metric>(column: MetricColumn<M>, value: number): Filter<object>
export function lte(column: Column<'date'>, value: string): Filter<object>
export function lte(column: Column<any> | MetricColumn<any>, value: any): Filter<object> {
  return metricOrDimFilter(column, 'metricLte', 'lte', String(value))
}

// lt - less than (date dimension or metric column only)
export function lt<M extends Metric>(column: MetricColumn<M>, value: number): Filter<object>
export function lt(column: Column<'date'>, value: string): Filter<object>
export function lt(column: Column<any> | MetricColumn<any>, value: any): Filter<object> {
  return metricOrDimFilter(column, 'metricLt', 'lt', String(value))
}

// between - inclusive range (date dimension or metric column only)
export function between<M extends Metric>(column: MetricColumn<M>, start: number, end: number): Filter<object>
export function between(column: Column<'date'>, start: string, end: string): Filter<object>
export function between(column: Column<any> | MetricColumn<any>, start: any, end: any): Filter<object> {
  return metricOrDimFilter(column, 'metricBetween', 'between', String(start), String(end))
}

// topLevel - filters to top-level pages only (slash counting heuristic)
export function topLevel(column: Column<'page'>): Filter<object> {
  return leafFilter(column.dimension, 'topLevel', '')
}
