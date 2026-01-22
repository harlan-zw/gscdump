import type { Column, Dimension, DimensionValueMap, Filter, FilterOperator, MergeConstraints, QueryParam, QueryParamName, QueryParamValueMap } from './types'

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
  return {
    _constraints: {} as any,
    _filters: [{
      dimension: key,
      operator: 'equals',
      expression: String(value),
    }],
  } as Filter<any>
}

// ne - excludes value (no narrowing - can't express Exclude in result)
export function ne<D extends Dimension>(
  column: Column<D>,
  value: DimensionValueMap[D],
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'notEquals',
      expression: String(value),
    }],
  } as Filter<object>
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
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'contains',
      expression: pattern,
    }],
  } as Filter<object>
}

// like - SQL LIKE pattern match, no narrowing (converts % to contains)
export function like<D extends Dimension>(
  column: Column<D>,
  pattern: string,
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'contains',
      expression: pattern.replace(/%/g, ''), // Convert SQL LIKE to contains
    }],
  } as Filter<object>
}

// regex - regex match, no narrowing
export function regex<D extends Dimension>(
  column: Column<D>,
  pattern: RegExp | string,
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'includingRegex',
      expression: typeof pattern === 'string' ? pattern : pattern.source,
    }],
  } as Filter<object>
}

// excludingRegex - regex exclusion, no narrowing
export function notRegex<D extends Dimension>(
  column: Column<D>,
  pattern: RegExp | string,
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'excludingRegex',
      expression: typeof pattern === 'string' ? pattern : pattern.source,
    }],
  } as Filter<object>
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

const DATE_OPS = ['gte', 'gt', 'lte', 'lt', 'between'] as const

// not - inverts filter, no narrowing
export function not<F extends Filter<any>>(filter: F): Filter<object> {
  const inverted = filter._filters
    .filter(f => !DATE_OPS.includes(f.operator as any)) // Skip date operators
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

// gte - greater than or equal (primarily for date)
export function gte<D extends Dimension>(
  column: Column<D>,
  value: DimensionValueMap[D],
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'gte',
      expression: String(value),
    }],
  } as Filter<object>
}

// gt - greater than (primarily for date, adds 1 day)
export function gt<D extends Dimension>(
  column: Column<D>,
  value: DimensionValueMap[D],
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'gt',
      expression: String(value),
    }],
  } as Filter<object>
}

// lte - less than or equal (primarily for date)
export function lte<D extends Dimension>(
  column: Column<D>,
  value: DimensionValueMap[D],
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'lte',
      expression: String(value),
    }],
  } as Filter<object>
}

// lt - less than (primarily for date, subtracts 1 day)
export function lt<D extends Dimension>(
  column: Column<D>,
  value: DimensionValueMap[D],
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'lt',
      expression: String(value),
    }],
  } as Filter<object>
}

// between - inclusive range (primarily for date)
export function between<D extends Dimension>(
  column: Column<D>,
  start: DimensionValueMap[D],
  end: DimensionValueMap[D],
): Filter<object> {
  return {
    _constraints: {},
    _filters: [{
      dimension: column.dimension,
      operator: 'between',
      expression: String(start),
      expression2: String(end),
    }],
  } as Filter<object>
}
