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

// like - SQL LIKE pattern match, no narrowing (converts % to contains)
export function like<D extends Dimension>(
  column: Column<D>,
  pattern: string,
): Filter<object> {
  return leafFilter(column.dimension, 'contains', pattern.replace(/%/g, ''))
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
export function or<F extends Filter<any>[]>(
  ...filters: F
): Filter<object> {
  return {
    _constraints: {},
    _filters: filters.flatMap(f => f._filters),
    _groupType: 'or',
  } as Filter<object>
}

// not - inverts filter, no narrowing
export function not<F extends Filter<any>>(filter: F): Filter<object> {
  const inverted = filter._filters
    .filter(f => !DATE_OPERATORS.includes(f.operator as any)) // Skip date operators
    .map(f => ({
      ...f,
      operator: invertOperator(f.operator as FilterOperator),
    }))
  return {
    _constraints: {},
    _filters: inverted,
  } as Filter<object>
}

function invertOperator(op: FilterOperator): FilterOperator {
  const inversions: Record<FilterOperator, FilterOperator> = {
    equals: 'notEquals',
    notEquals: 'equals',
    contains: 'notContains',
    notContains: 'contains',
    includingRegex: 'excludingRegex',
    excludingRegex: 'includingRegex',
  }
  return inversions[op]
}

// gte - greater than or equal (for date dimensions or metric columns)
export function gte<M extends Metric>(column: MetricColumn<M>, value: number): Filter<object>
export function gte<D extends Dimension>(column: Column<D>, value: DimensionValueMap[D]): Filter<object>
export function gte(column: Column<any> | MetricColumn<any>, value: any): Filter<object> {
  return metricOrDimFilter(column, 'metricGte', 'gte', String(value))
}

// gt - greater than (for date dimensions or metric columns)
export function gt<M extends Metric>(column: MetricColumn<M>, value: number): Filter<object>
export function gt<D extends Dimension>(column: Column<D>, value: DimensionValueMap[D]): Filter<object>
export function gt(column: Column<any> | MetricColumn<any>, value: any): Filter<object> {
  return metricOrDimFilter(column, 'metricGt', 'gt', String(value))
}

// lte - less than or equal (for date dimensions or metric columns)
export function lte<M extends Metric>(column: MetricColumn<M>, value: number): Filter<object>
export function lte<D extends Dimension>(column: Column<D>, value: DimensionValueMap[D]): Filter<object>
export function lte(column: Column<any> | MetricColumn<any>, value: any): Filter<object> {
  return metricOrDimFilter(column, 'metricLte', 'lte', String(value))
}

// lt - less than (for date dimensions or metric columns)
export function lt<M extends Metric>(column: MetricColumn<M>, value: number): Filter<object>
export function lt<D extends Dimension>(column: Column<D>, value: DimensionValueMap[D]): Filter<object>
export function lt(column: Column<any> | MetricColumn<any>, value: any): Filter<object> {
  return metricOrDimFilter(column, 'metricLt', 'lt', String(value))
}

// between - inclusive range (for date dimensions or metric columns)
export function between<M extends Metric>(column: MetricColumn<M>, start: number, end: number): Filter<object>
export function between<D extends Dimension>(column: Column<D>, start: DimensionValueMap[D], end: DimensionValueMap[D]): Filter<object>
export function between(column: Column<any> | MetricColumn<any>, start: any, end: any): Filter<object> {
  return metricOrDimFilter(column, 'metricBetween', 'between', String(start), String(end))
}

// topLevel - filters to top-level pages only (slash counting heuristic)
export function topLevel(column: Column<'page'>): Filter<object> {
  return leafFilter(column.dimension, 'topLevel', '')
}
