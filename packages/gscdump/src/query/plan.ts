import type { TableName } from '../contracts'
import type { Result } from '../core/result'

import type { QueryError } from './errors'
import type {
  BuilderState,
  Dimension,
  FilterInput,
  FilterOperator,
  InternalFilter,
  Metric,
  MetricOperator,
  QueryParamName,
} from './types'
import { err, ok, unwrapResult } from '../core/result'
import { queryErrors, queryErrorToException } from './errors'
import { isDateOperator, isMetric, isQueryParam, isRegexOperator } from './operator-meta'
import {
  extractDateRange,
  extractMetricFilters,
  extractSpecialOperatorFilters,
  normalizeFilter,
} from './resolver'

export type { TableName } from '../contracts'
// Re-exported so the `gscdump/query/plan` subpath keeps surfacing the two error
// classes engines import from here (resolver/datasets.ts), now defined in `./errors`.
export { UnresolvableDatasetError, UnsupportedLogicalCapabilityError } from './errors'
export type { QueryError, QueryErrorKind } from './errors'

// One source of truth: a logical dataset IS a storage table name. The engine
// compiler and analysis adapters both consume `LogicalDataset`; keeping the
// alias here means a new table in `analytics/storage` automatically becomes a
// valid dataset, and rename drift fails to compile.
export type LogicalDataset = TableName
export type ComparisonFilter = 'new' | 'lost' | 'improving' | 'declining'

export interface PlannerCapabilities {
  regex?: boolean
  multiDataset?: boolean
  comparisonJoin?: boolean
  windowTotals?: boolean
}

export interface LogicalDimensionFilter {
  dimension: Dimension
  operator: FilterOperator
  expression: string
  expression2?: string
}

export interface LogicalMetricFilter {
  metric: Metric
  operator: MetricOperator
  expression: number
  expression2?: number
}

// Tree representation of dimension filters that preserves AND/OR group
// structure. The compiler uses this to emit `(a OR b)`-style SQL; the flat
// `dimensionFilters` list is retained for callers that only need the leaves
// (e.g. dataset inference).
export interface LogicalFilterLeaf {
  kind: 'leaf'
  filter: LogicalDimensionFilter
}

export interface LogicalFilterGroup {
  kind: 'group'
  groupType: 'and' | 'or'
  children: LogicalFilterNode[]
}

export type LogicalFilterNode = LogicalFilterLeaf | LogicalFilterGroup

export interface LogicalQueryPlan {
  dataset: LogicalDataset
  dimensions: Dimension[]
  groupByDimensions: Dimension[]
  hasDate: boolean
  metrics: Metric[]
  dateRange: {
    startDate: string
    endDate: string
  }
  dimensionFilters: LogicalDimensionFilter[]
  dimensionFilterTree?: LogicalFilterNode
  metricFilters: LogicalMetricFilter[]
  // Row-level WHERE filters on raw metric columns. Distinct from `metricFilters`
  // (HAVING). Sourced from `state.prefilter`.
  prefilters: LogicalMetricFilter[]
  specialFilters: {
    topLevel: boolean
  }
  queryParams: Partial<Record<QueryParamName, string>>
  orderBy?: BuilderState['orderBy']
  rowLimit?: number
  startRow?: number
}

export interface LogicalComparisonPlan {
  current: LogicalQueryPlan
  previous: LogicalQueryPlan
  comparisonFilter?: ComparisonFilter
}

function collectInternalFilters(filter: FilterInput | undefined): InternalFilter[] {
  if (!filter || !('_filters' in filter))
    return []

  const flat = filter._filters as InternalFilter[]
  const nested = filter._nestedGroups?.flatMap(group => collectInternalFilters(group)) ?? []
  return [...flat, ...nested]
}

export function inferDataset(
  dimensions: readonly Dimension[],
  filterDims: readonly Dimension[] = [],
): LogicalDataset {
  const allDims = new Set<Dimension>([...dimensions, ...filterDims])
  const has = (dimension: Dimension): boolean => allDims.has(dimension)

  if (has('searchAppearance')) {
    if (has('page') && (has('query') || has('queryCanonical')))
      return 'search_appearance_page_queries'
    if (has('page'))
      return 'search_appearance_pages'
    if (has('query') || has('queryCanonical'))
      return 'search_appearance_queries'
    return 'search_appearance'
  }
  if (has('page') && (has('query') || has('queryCanonical')))
    return 'page_queries'
  if (has('query') || has('queryCanonical'))
    return 'queries'
  if (has('page'))
    return 'pages'
  if (has('country'))
    return 'countries'
  if (has('device'))
    return 'dates'
  // Date-only / no-dimension queries: route to `dates` — the per-`(site,
  // search_type, date)` table holds the TRUE site totals (incl. anonymized
  // impressions). Dimension-grouped tables undercount the host total under the
  // registered-host `page`-regex filter (ADR-0033).
  return 'dates'
}

// Each stored dataset carries exactly one dimension family (`page_keywords` is
// the sole composite). A query is resolvable from stored data only when every
// grouped + filtered dimension fits inside ONE family — GSC stores no other
// cross-dimension aggregate, so e.g. a `device` breakdown filtered by `query`
// has no stored home. `date`/`hour` are time axes present on every table and
// never constrain dataset choice.
// `device` is intentionally absent: the standalone `devices` table was retired
// and folded into the `dates` table as pivoted wide columns
// (`clicks_desktop` etc.). A `GROUP BY device` breakdown has no stored home —
// device-grained reads go through the `device-gap` / site-timeseries
// archetypes which read `dates` and pivot. A raw builder `device` breakdown is
// therefore unresolvable and routes to the live GSC API.
const RESOLVABLE_DIMENSION_FAMILIES: ReadonlyArray<ReadonlySet<Dimension>> = [
  new Set<Dimension>(['page', 'query', 'queryCanonical']),
  new Set<Dimension>(['country']),
  new Set<Dimension>(['searchAppearance', 'page', 'query', 'queryCanonical']),
]
const TIME_AXIS_DIMENSIONS = new Set<Dimension>(['date', 'hour'])

/**
 * True when every grouped + filtered dimension fits inside one stored dataset,
 * i.e. the query is answerable from stored Parquet/D1 tables without a live
 * GSC call. `inferDataset` always returns *some* dataset; this predicate is
 * how callers tell a genuine match from one that will fail at column-resolve
 * time.
 */
export function isDatasetResolvable(
  dimensions: readonly Dimension[],
  filterDims: readonly Dimension[] = [],
): boolean {
  const needed = new Set<Dimension>(
    [...dimensions, ...filterDims].filter(d => !TIME_AXIS_DIMENSIONS.has(d)),
  )
  if (needed.size === 0)
    return true
  return RESOLVABLE_DIMENSION_FAMILIES.some(family => [...needed].every(d => family.has(d)))
}

/**
 * `BuilderState`-level convenience for {@link isDatasetResolvable}: extracts
 * the state's dimension filters (the same way `buildLogicalPlan` does) and
 * checks them against the grouped dimensions. Lets routing code (e.g. the
 * composite source) detect a cross-dimension query without rebuilding a plan.
 */
export function isStateResolvable(state: BuilderState): boolean {
  const filterDims = collectInternalFilters(normalizeFilter(state.filter) as FilterInput | undefined)
    .filter(f => !isMetric(f.dimension))
    .filter(f => !(f.dimension === 'date' && isDateOperator(f.operator)))
    .filter(f => !(f.operator === 'topLevel' || f.operator.startsWith('metric')))
    .filter(f => !isQueryParam(f.dimension))
    .map(f => f.dimension as Dimension)
  return isDatasetResolvable(state.dimensions, filterDims)
}

// True iff the leaf is a real dimension predicate (not a date window, query
// param, metric HAVING, or topLevel marker). These get extracted onto the
// plan's top-level fields and must NOT appear in the dimension filter tree.
function isDimensionLeaf(filter: InternalFilter): boolean {
  if (isMetric(filter.dimension))
    return false
  if (filter.dimension === 'date' && isDateOperator(filter.operator))
    return false
  if (filter.operator === 'topLevel' || filter.operator.startsWith('metric'))
    return false
  if (isQueryParam(filter.dimension))
    return false
  return true
}

function toLogicalDimensionFilter(filter: InternalFilter): LogicalDimensionFilter {
  return {
    dimension: filter.dimension as Dimension,
    operator: filter.operator as FilterOperator,
    expression: filter.expression,
    expression2: filter.expression2,
  }
}

function buildDimensionFilterTree(
  filter: FilterInput | undefined,
): LogicalFilterNode | undefined {
  if (!filter || !('_filters' in filter))
    return undefined

  const groupType = (filter._groupType ?? 'and') as 'and' | 'or'
  const children: LogicalFilterNode[] = []

  for (const f of filter._filters as InternalFilter[]) {
    if (!isDimensionLeaf(f))
      continue
    children.push({ kind: 'leaf', filter: toLogicalDimensionFilter(f) })
  }

  for (const g of filter._nestedGroups ?? []) {
    const sub = buildDimensionFilterTree(g)
    if (sub)
      children.push(sub)
  }

  if (children.length === 0)
    return undefined
  if (children.length === 1)
    return children[0]
  return { kind: 'group', groupType, children }
}

/**
 * Errors-as-values core: builds the logical plan or returns a typed `QueryError`
 * for every modelled failure (missing date range, a regex filter on an engine
 * without regex pushdown, a cross-dimension query with no stored home).
 * `buildLogicalPlan` is the throwing wrapper for call sites that prefer exceptions.
 */
export function buildLogicalPlanResult(
  state: BuilderState,
  capabilities: PlannerCapabilities = {},
): Result<LogicalQueryPlan, QueryError> {
  // Coerce wire-format filters (`{ type, filters | column, value, from, to }`)
  // up-front so every downstream traversal sees the SDK's `_filters` shape.
  // Browser path (engine-duckdb-wasm) feeds raw consumer state; server path is
  // already pre-normalized by gscdump.com but normalizing twice is a no-op.
  const normalizedFilter = normalizeFilter(state.filter) as FilterInput | undefined

  const { startDate, endDate } = extractDateRange(normalizedFilter)
  if (!startDate || !endDate)
    return err(queryErrors.missingDateRange())

  const allFilters = collectInternalFilters(normalizedFilter)

  // Regex pushdown gate, hoisted to a single pre-check over the flat (incl.
  // nested) dimension leaves. `collectInternalFilters` already recurses nested
  // groups, so this covers both the `dimensionFilters` list and the filter tree.
  if (!capabilities.regex && allFilters.some(f => isDimensionLeaf(f) && isRegexOperator(f.operator)))
    return err(queryErrors.unsupportedCapability('regex', 'logical plan'))

  const metricFilters = extractMetricFilters(normalizedFilter)
  const specialFilters = extractSpecialOperatorFilters(normalizedFilter)
  const normalizedPrefilter = normalizeFilter(state.prefilter) as FilterInput | undefined
  const prefilters = extractMetricFilters(normalizedPrefilter)

  const queryParams: Partial<Record<QueryParamName, string>> = {}
  const dimensionFilters: LogicalDimensionFilter[] = []

  for (const filter of allFilters) {
    if (isMetric(filter.dimension))
      continue
    if (filter.dimension === 'date' && isDateOperator(filter.operator))
      continue
    if (filter.operator === 'topLevel' || filter.operator.startsWith('metric'))
      continue
    if (isQueryParam(filter.dimension)) {
      queryParams[filter.dimension] = filter.expression
      continue
    }

    dimensionFilters.push({
      dimension: filter.dimension as Dimension,
      operator: filter.operator as FilterOperator,
      expression: filter.expression,
      expression2: filter.expression2,
    })
  }

  const dimensionFilterTree = buildDimensionFilterTree(normalizedFilter)

  const filterDims = dimensionFilters.map(filter => filter.dimension)
  // A cross-dimension query (grouped + filtered dimensions spanning two stored
  // datasets) has no table carrying every referenced column. Fail here with a
  // typed error rather than letting the SQL resolver throw a raw "unknown
  // column" Error during compilation.
  if (!isDatasetResolvable(state.dimensions, filterDims))
    return err(queryErrors.unresolvableDataset(state.dimensions, filterDims))
  const dataset = inferDataset(state.dimensions, filterDims)

  return ok({
    dataset,
    dimensions: [...state.dimensions],
    groupByDimensions: state.dimensions.filter(d => d !== 'date'),
    hasDate: state.dimensions.includes('date'),
    metrics: state.metrics ? [...state.metrics] : ['clicks', 'impressions', 'ctr', 'position'],
    dateRange: { startDate, endDate },
    dimensionFilters,
    dimensionFilterTree,
    metricFilters: metricFilters.map(filter => ({
      metric: filter.dimension as Metric,
      operator: filter.operator as MetricOperator,
      expression: Number(filter.expression),
      expression2: filter.expression2 == null ? undefined : Number(filter.expression2),
    })),
    prefilters: prefilters.map(filter => ({
      metric: filter.dimension as Metric,
      operator: filter.operator as MetricOperator,
      expression: Number(filter.expression),
      expression2: filter.expression2 == null ? undefined : Number(filter.expression2),
    })),
    specialFilters: {
      topLevel: specialFilters.some(filter => filter.operator === 'topLevel'),
    },
    queryParams,
    orderBy: state.orderBy,
    rowLimit: state.rowLimit,
    startRow: state.startRow,
  })
}

export function buildLogicalPlan(
  state: BuilderState,
  capabilities: PlannerCapabilities = {},
): LogicalQueryPlan {
  return unwrapResult(buildLogicalPlanResult(state, capabilities), queryErrorToException)
}

/**
 * Errors-as-values core for the comparison plan: returns a typed `QueryError`
 * when the engine lacks the comparison-join or multi-dataset capability the
 * paired queries need, or when either side fails to plan.
 */
export function buildLogicalComparisonPlanResult(
  current: BuilderState,
  previous: BuilderState,
  capabilities: PlannerCapabilities = {},
  comparisonFilter?: ComparisonFilter,
): Result<LogicalComparisonPlan, QueryError> {
  if (!capabilities.comparisonJoin)
    return err(queryErrors.unsupportedCapability('comparisonJoin', 'logical comparison plan'))

  const currentResult = buildLogicalPlanResult(current, capabilities)
  if (!currentResult.ok)
    return currentResult
  const previousResult = buildLogicalPlanResult(previous, capabilities)
  if (!previousResult.ok)
    return previousResult

  const usesMultipleDatasets = currentResult.value.dataset !== previousResult.value.dataset
  if (usesMultipleDatasets && !capabilities.multiDataset)
    return err(queryErrors.unsupportedCapability('multiDataset', 'logical comparison plan'))

  return ok({
    current: currentResult.value,
    previous: previousResult.value,
    comparisonFilter,
  })
}

export function buildLogicalComparisonPlan(
  current: BuilderState,
  previous: BuilderState,
  capabilities: PlannerCapabilities = {},
  comparisonFilter?: ComparisonFilter,
): LogicalComparisonPlan {
  return unwrapResult(
    buildLogicalComparisonPlanResult(current, previous, capabilities, comparisonFilter),
    queryErrorToException,
  )
}
