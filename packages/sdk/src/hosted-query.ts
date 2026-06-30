import type {
  BuilderState,
  DataDetailOptions,
  DataQueryOptions,
  GscdumpAnalysisParams,
  GscdumpDateRangeParams,
  GscdumpPageTrendParams,
  GscdumpQueryTrendParams,
  IndexingDiagnosticsParams,
  IndexingUrlsParams,
  SourceInfoOptions,
} from '@gscdump/contracts'

export type GscSearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'

export interface SearchTypeOptions {
  searchType?: GscSearchType
}

export interface SourceRangeOptions {
  start?: string
  end?: string
  startDate?: string
  endDate?: string
}

export interface AnalysisSourcesOptions extends SearchTypeOptions, SourceRangeOptions {
  tables?: string[] | string
}

type DataQueryOptionsWithSearchType = DataQueryOptions & SearchTypeOptions
type DataDetailOptionsWithSearchType = DataDetailOptions & SearchTypeOptions
type AnalysisParamsWithSearchType = GscdumpAnalysisParams & SearchTypeOptions

export const DEFAULT_SEARCH_TYPE: GscSearchType = 'web'

function isAnalysisSourcesOptions(value: unknown): value is AnalysisSourcesOptions {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function withDefaultSearchType<T extends object>(value: T, searchType?: GscSearchType): T & SearchTypeOptions
export function withDefaultSearchType<T>(value: T, searchType?: GscSearchType): T
export function withDefaultSearchType<T>(value: T, searchType?: GscSearchType): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return value
  const scoped = value as Record<string, unknown> & SearchTypeOptions
  return {
    ...scoped,
    searchType: searchType ?? scoped.searchType ?? DEFAULT_SEARCH_TYPE,
  } as T
}

export function searchTypeQuery(searchType?: GscSearchType): Record<string, string> {
  return { searchType: searchType ?? DEFAULT_SEARCH_TYPE }
}

export function dateRangeOptionsQuery(options: SourceRangeOptions | undefined): Record<string, string> {
  const query: Record<string, string> = {}
  const start = options?.start ?? options?.startDate
  const end = options?.end ?? options?.endDate
  if (start)
    query.start = start
  if (end)
    query.end = end
  return query
}

export function sourceInfoQuery(options: SourceInfoOptions | undefined): Record<string, string> {
  return {
    ...searchTypeQuery(options?.searchType as GscSearchType | undefined),
    ...dateRangeOptionsQuery(options),
  }
}

export function tablesQuery(
  tablesOrOptions: string[] | string | AnalysisSourcesOptions | undefined,
  options?: SearchTypeOptions & SourceRangeOptions,
): Record<string, string> {
  const tables = isAnalysisSourcesOptions(tablesOrOptions) ? tablesOrOptions.tables : tablesOrOptions
  const source = isAnalysisSourcesOptions(tablesOrOptions) ? tablesOrOptions : options
  const query = {
    ...searchTypeQuery(source?.searchType),
    ...dateRangeOptionsQuery(source),
  }
  if (tables)
    query.tables = Array.isArray(tables) ? tables.join(',') : tables
  return query
}

export function dataQuery(state: BuilderState, options?: DataQueryOptions): Record<string, string> {
  const opts = options as DataQueryOptionsWithSearchType | undefined
  const scoped = withDefaultSearchType(state, opts?.searchType)
  const query: Record<string, string> = {
    q: JSON.stringify(scoped),
    searchType: scoped.searchType ?? DEFAULT_SEARCH_TYPE,
  }
  if (opts?.comparison)
    query.qc = JSON.stringify(withDefaultSearchType(opts.comparison, scoped.searchType))
  if (opts?.filter)
    query.filter = opts.filter
  return query
}

export function dataDetailQuery(state: BuilderState, options?: DataDetailOptions): Record<string, string> {
  const opts = options as DataDetailOptionsWithSearchType | undefined
  const scoped = withDefaultSearchType(state, opts?.searchType)
  const query: Record<string, string> = {
    q: JSON.stringify(scoped),
    searchType: scoped.searchType ?? DEFAULT_SEARCH_TYPE,
  }
  if (opts?.comparison)
    query.qc = JSON.stringify(withDefaultSearchType(opts.comparison, scoped.searchType))
  return query
}

export function analysisQuery(params: GscdumpAnalysisParams): Record<string, string | number> {
  const query: Record<string, string | number> = {
    preset: params.preset,
    startDate: params.startDate,
    endDate: params.endDate,
  }
  if (params.prevStartDate)
    query.prevStartDate = params.prevStartDate
  if (params.prevEndDate)
    query.prevEndDate = params.prevEndDate
  if (params.brandTerms)
    query.brandTerms = params.brandTerms
  if (params.limit != null)
    query.limit = params.limit
  if (params.offset != null)
    query.offset = params.offset
  if (params.search)
    query.search = params.search
  if (params.minImpressions != null)
    query.minImpressions = params.minImpressions
  if (params.minPosition != null)
    query.minPosition = params.minPosition
  if (params.maxPosition != null)
    query.maxPosition = params.maxPosition
  if (params.maxCtr != null)
    query.maxCtr = params.maxCtr
  query.searchType = (params as AnalysisParamsWithSearchType).searchType ?? DEFAULT_SEARCH_TYPE
  return query
}

export function indexingUrlsQuery(params: IndexingUrlsParams = {}): Record<string, string | number> {
  const query: Record<string, string | number> = {}
  if (params.limit != null)
    query.limit = params.limit
  if (params.offset != null)
    query.offset = params.offset
  if (params.status)
    query.status = params.status
  if (params.issue)
    query.issue = params.issue
  if (params.search)
    query.search = params.search
  return query
}

export function indexingDiagnosticsQuery(params: IndexingDiagnosticsParams = {}): Record<string, string | number> {
  const query: Record<string, string | number> = {}
  if (params.sampleIssues) {
    query.sampleIssues = Array.isArray(params.sampleIssues)
      ? params.sampleIssues.join(',')
      : params.sampleIssues
  }
  if (params.sampleLimit != null)
    query.sampleLimit = params.sampleLimit
  return query
}

export function dateRangeQuery(params: GscdumpDateRangeParams): Record<string, string> {
  return { startDate: params.startDate, endDate: params.endDate }
}

export function queryTrendQuery(params: GscdumpQueryTrendParams): Record<string, string> {
  const query: Record<string, string> = {
    startDate: params.startDate,
    endDate: params.endDate,
    searchType: params.searchType ?? DEFAULT_SEARCH_TYPE,
  }
  if (params.prevStartDate)
    query.prevStartDate = params.prevStartDate
  if (params.prevEndDate)
    query.prevEndDate = params.prevEndDate
  return query
}

export function pageTrendQuery(params: GscdumpPageTrendParams): Record<string, string> {
  const query: Record<string, string> = {
    startDate: params.startDate,
    endDate: params.endDate,
    searchType: params.searchType ?? DEFAULT_SEARCH_TYPE,
  }
  if (params.prevStartDate)
    query.prevStartDate = params.prevStartDate
  if (params.prevEndDate)
    query.prevEndDate = params.prevEndDate
  return query
}
