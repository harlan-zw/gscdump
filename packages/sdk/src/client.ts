import type {
  AddPartnerTeamMemberParams,
  BindPartnerSiteTeamParams,
  BuilderState,
  BulkRegisterPartnerSitesParams,
  BulkRegisterPartnerSitesResponse,
  CreatePartnerTeamParams,
  DataDetailOptions,
  DataQueryOptions,
  DeletePartnerUserResponse,
  GscdumpAnalysisParams,
  GscdumpAnalysisResponse,
  GscdumpAnalysisSourcesResponse,
  GscdumpAvailableSite,
  GscdumpCanonicalMismatchesResponse,
  GscdumpDataDetailResponse,
  GscdumpDataResponse,
  GscdumpDateRangeParams,
  GscdumpIndexingDiagnosticsResponse,
  GscdumpIndexingResponse,
  GscdumpIndexingUrlsResponse,
  GscdumpIndexPercentResponse,
  GscdumpKeywordSparklinesParams,
  GscdumpKeywordSparklinesResponse,
  GscdumpPageTrendParams,
  GscdumpPageTrendResponse,
  GscdumpPermissionRecovery,
  GscdumpQueryTrendParams,
  GscdumpQueryTrendResponse,
  GscdumpSitemapChangesResponse,
  GscdumpSitemapsResponse,
  GscdumpSiteRegistration,
  GscdumpSyncStatusResponse,
  GscdumpTopAssociationParams,
  GscdumpTopAssociationResponse,
  GscdumpUserRegistration,
  GscdumpUserSettings,
  GscdumpUserSite,
  GscdumpUserStatus,
  GscdumpUserTokenUpdate,
  IndexingInspectRateLimited,
  IndexingInspectRequest,
  IndexingInspectResponse,
  IndexingUrlsParams,
  PartnerClient,
  PartnerLifecycleResponse,
  RegisterPartnerSiteParams,
  RegisterPartnerUserParams,
  UpdatePartnerUserTokensParams,
} from '@gscdump/contracts'
import type { Result } from 'gscdump/result'
import type { HostedClientOptions, HostedFetch, HostedFetchOptions, HostedHeaders } from './request'
import { partnerEndpointSchemas, partnerRoutes } from '@gscdump/contracts/partner'
import { err, ok, unwrapResult } from 'gscdump/result'
import { PartnerApiError, partnerErrorToException } from './errors'
import { findLifecycleSite, lifecycleSiteToSyncStatus } from './lifecycle'
import { createHostedRequester } from './request'

export type PartnerFetch = HostedFetch
export type PartnerHeaders = HostedHeaders
export type PartnerFetchOptions = HostedFetchOptions

export interface PartnerClientOptions extends HostedClientOptions {
  /**
   * Origin API base. Use `/api` for same-origin Nitro routes, or pass a full
   * remote origin base from the host app. The client has no baked-in origin.
   */
  apiBase?: string
  /** Convenience auth hook. Equivalent to supplying `headers: { 'x-api-key': apiKey }`. */
  apiKey?: string
  /** Any ofetch-compatible instance: global `$fetch`, `useGscFetch()`, or a custom test fake. */
  fetch?: PartnerFetch
  /** Static or lazy headers. Lazy headers are resolved on every operation. */
  headers?: PartnerHeaders
  /** Validate request payloads and response bodies with exported Zod schemas. */
  validate?: boolean | 'request' | 'response'
}

type GscSearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'
interface SearchTypeOptions {
  searchType?: GscSearchType
}
interface SourceRangeOptions {
  start?: string
  end?: string
  startDate?: string
  endDate?: string
}
interface AnalysisSourcesOptions extends SearchTypeOptions {
  tables?: string[] | string
  start?: string
  end?: string
  startDate?: string
  endDate?: string
}
type BuilderStateWithSearchType = BuilderState & SearchTypeOptions
type DataQueryOptionsWithSearchType = DataQueryOptions & SearchTypeOptions
type DataDetailOptionsWithSearchType = DataDetailOptions & SearchTypeOptions
type AnalysisParamsWithSearchType = GscdumpAnalysisParams & SearchTypeOptions
const DEFAULT_SEARCH_TYPE: GscSearchType = 'web'

function withDefaultSearchType<T extends BuilderState>(state: T, searchType?: GscSearchType): T & SearchTypeOptions {
  const scoped = state as BuilderStateWithSearchType
  return {
    ...state,
    searchType: searchType ?? scoped.searchType ?? DEFAULT_SEARCH_TYPE,
  }
}

function dataQuery(state: BuilderState, options?: DataQueryOptions): Record<string, string> {
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

function dataDetailQuery(state: BuilderState, options?: DataDetailOptions): Record<string, string> {
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

/**
 * Errors-as-values core for analysis-param validation: a missing `brandTerms`
 * on a brand/non-brand preset is a caller-actionable `validation` failure, so
 * return it as a modelled `PartnerApiError` rather than only throwing.
 */
function validateAnalysisParamsResult(params: GscdumpAnalysisParams): Result<GscdumpAnalysisParams, PartnerApiError> {
  if ((params.preset === 'non-brand' || params.preset === 'brand-only') && !params.brandTerms?.trim()) {
    return err(new PartnerApiError({
      kind: 'validation',
      statusCode: 400,
      message: 'brandTerms is required for brand/non-brand presets',
    }))
  }
  return ok(params)
}

function assertAnalysisParams(params: GscdumpAnalysisParams): void {
  unwrapResult(validateAnalysisParamsResult(params), partnerErrorToException)
}

function analysisQuery(params: GscdumpAnalysisParams): Record<string, string | number> {
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

function indexingUrlsQuery(params: IndexingUrlsParams = {}): Record<string, string | number> {
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

function isAnalysisSourcesOptions(value: unknown): value is AnalysisSourcesOptions {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function tablesQuery(
  tablesOrOptions: string[] | string | AnalysisSourcesOptions | undefined,
  options?: SearchTypeOptions & SourceRangeOptions,
): Record<string, string> {
  const tables = isAnalysisSourcesOptions(tablesOrOptions) ? tablesOrOptions.tables : tablesOrOptions
  const source = isAnalysisSourcesOptions(tablesOrOptions) ? tablesOrOptions : options
  const query: Record<string, string> = { searchType: source?.searchType ?? DEFAULT_SEARCH_TYPE }
  const start = source?.start ?? source?.startDate
  const end = source?.end ?? source?.endDate
  if (start)
    query.start = start
  if (end)
    query.end = end
  if (tables)
    query.tables = Array.isArray(tables) ? tables.join(',') : tables
  return query
}

function dateRangeQuery(params: GscdumpDateRangeParams): Record<string, string> {
  return { startDate: params.startDate, endDate: params.endDate }
}

function queryTrendQuery(params: GscdumpQueryTrendParams): Record<string, string> {
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

function pageTrendQuery(params: GscdumpPageTrendParams): Record<string, string> {
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createPartnerClient(options: PartnerClientOptions = {}): PartnerClient {
  const { request, requestResult, shouldValidate } = createHostedRequester(options, { apiBase: '/api' })

  // Errors-as-values core for `waitForUserReady`: polling exhaustion while the
  // user db is still provisioning is a caller-actionable `provisioning` failure.
  // The `data` channel carries the last observed status so callers can inspect
  // it. The throwing wrapper re-raises the original plain `Error` (with `.data`)
  // identity that existing consumers catch.
  async function waitForUserReadyResult(
    userId: string,
    waitOptions: { attempts?: number, intervalMs?: number } = {},
  ): Promise<Result<GscdumpUserStatus, PartnerApiError>> {
    const attempts = waitOptions.attempts ?? 12
    const intervalMs = waitOptions.intervalMs ?? 1000
    let latest: GscdumpUserStatus | null = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await requestResult<GscdumpUserStatus>(partnerRoutes.users.status(userId))
      if (!result.ok)
        return result
      latest = result.value
      if (latest.status === 'ready')
        return ok(latest)
      if (attempt < attempts - 1)
        await sleep(intervalMs)
    }
    return err(new PartnerApiError({
      kind: 'provisioning',
      statusCode: 409,
      message: 'gscdump user database is still provisioning',
      data: latest,
    }))
  }

  // Re-raise the provisioning-exhaustion failure as the original plain
  // `Error & { data }` shape (not a `PartnerApiError`) so consumers that
  // `.catch`/`.toMatchObject` on `{ message, data }` keep working unchanged.
  function waitForUserReadyToException(error: PartnerApiError): unknown {
    const e = new Error(error.message) as Error & { data?: unknown }
    e.data = error.data
    return e
  }

  // Errors-as-values core for `waitForUserLifecycleReady`: discriminates the
  // terminal lifecycle states into modelled `auth` (re-auth required) vs
  // `provisioning` (not connected / still provisioning) `PartnerApiError`s.
  async function waitForUserLifecycleReadyResult(
    userId: string,
    waitOptions: { attempts?: number, intervalMs?: number } = {},
  ): Promise<Result<PartnerLifecycleResponse, PartnerApiError>> {
    const attempts = waitOptions.attempts ?? 12
    const intervalMs = waitOptions.intervalMs ?? 1000
    let latest: PartnerLifecycleResponse | null = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await requestResult<PartnerLifecycleResponse>(partnerRoutes.users.lifecycle(userId))
      if (!result.ok)
        return result
      latest = result.value
      const status = latest.account.status
      if (status === 'ready')
        return ok(latest)
      if (status === 'refresh_missing' || status === 'scope_missing' || status === 'reauth_required') {
        return err(new PartnerApiError({
          kind: 'auth',
          statusCode: 401,
          message: 'Google Search Console authorization must be refreshed',
          data: latest.account,
        }))
      }
      if (status === 'disconnected' || status === 'oauth_received') {
        return err(new PartnerApiError({
          kind: 'provisioning',
          statusCode: 409,
          message: 'gscdump user is not fully connected',
          data: latest.account,
        }))
      }
      if (attempt < attempts - 1)
        await sleep(intervalMs)
    }
    return err(new PartnerApiError({
      kind: 'provisioning',
      statusCode: 409,
      message: 'gscdump user database is still provisioning',
      data: latest,
    }))
  }

  // Errors-as-values core for `getSiteSyncStatus`: a lifecycle round-trip that
  // omits the requested site is a caller-actionable `not-found`.
  async function getSiteSyncStatusResult(
    siteId: string,
    userId?: string,
  ): Promise<Result<GscdumpSyncStatusResponse, PartnerApiError>> {
    if (!userId)
      return requestResult<GscdumpSyncStatusResponse>(partnerRoutes.sites.syncStatus(siteId))
    const lifecycle = await requestResult<PartnerLifecycleResponse>(partnerRoutes.users.lifecycle(userId))
    if (!lifecycle.ok)
      return lifecycle
    const site = findLifecycleSite(lifecycle.value, siteId)
    if (!site) {
      return err(new PartnerApiError({
        kind: 'not-found',
        statusCode: 404,
        message: 'gscdump lifecycle site not found',
        data: { siteId, userId },
      }))
    }
    return ok(lifecycleSiteToSyncStatus(site))
  }

  return {
    registerUser(params: RegisterPartnerUserParams) {
      const body = shouldValidate('request') ? partnerEndpointSchemas.registerUser.body.parse(params) : params
      return request<GscdumpUserRegistration>(partnerRoutes.users.register, {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.registerUser.response)
    },

    updateUserTokens(userId: string, params: UpdatePartnerUserTokensParams) {
      const body = shouldValidate('request') ? partnerEndpointSchemas.updateUserTokens.body.parse(params) : params
      return request<GscdumpUserTokenUpdate>(partnerRoutes.users.tokens(userId), {
        method: 'PATCH',
        body,
      }, partnerEndpointSchemas.updateUserTokens.response)
    },

    getUserStatus(userId: string) {
      return request<GscdumpUserStatus>(partnerRoutes.users.status(userId), {}, partnerEndpointSchemas.getUserStatus.response)
    },

    getUserLifecycle(userId: string) {
      return request<PartnerLifecycleResponse>(partnerRoutes.users.lifecycle(userId))
    },

    async waitForUserReady(userId: string, waitOptions: { attempts?: number, intervalMs?: number } = {}) {
      return unwrapResult(await waitForUserReadyResult(userId, waitOptions), waitForUserReadyToException)
    },

    // Lifecycle-aware variant of `waitForUserReady`. Polls
    // `getUserLifecycle(userId)` and discriminates between states:
    //   - `ready`                                              → resolve
    //   - `refresh_missing|scope_missing|reauth_required`      → throw `auth` (401)
    //   - `disconnected|oauth_received`                        → throw `provisioning` (409)
    //   - polling exhausted (still provisioning, db_provisioning, etc.) → throw `provisioning` (409)
    // Consumers map `PartnerApiError.kind` to their HTTP framework's error shape.
    async waitForUserLifecycleReady(
      userId: string,
      waitOptions: { attempts?: number, intervalMs?: number } = {},
    ): Promise<PartnerLifecycleResponse> {
      return unwrapResult(await waitForUserLifecycleReadyResult(userId, waitOptions), partnerErrorToException)
    },

    getUserSites(userId: string) {
      return request<{ sites: GscdumpUserSite[] }>(partnerRoutes.users.sites(userId), {}, partnerEndpointSchemas.getUserSites.response)
    },

    getAvailableSites(userId: string) {
      return request<{ sites: GscdumpAvailableSite[] }>(partnerRoutes.users.availableSites(userId), {}, partnerEndpointSchemas.getAvailableSites.response)
    },

    registerSite(params: RegisterPartnerSiteParams) {
      const body = shouldValidate('request') ? partnerEndpointSchemas.registerSite.body.parse(params) : params
      return request<GscdumpSiteRegistration>(partnerRoutes.partner.sites.register, {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.registerSite.response)
    },

    bulkRegisterSites(params: BulkRegisterPartnerSitesParams) {
      const body = shouldValidate('request') ? partnerEndpointSchemas.bulkRegisterSites.body.parse(params) : params
      return request<BulkRegisterPartnerSitesResponse>(partnerRoutes.partner.sites.bulkRegister, {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.bulkRegisterSites.response)
    },

    deleteUser(userId: string) {
      return request<DeletePartnerUserResponse>(partnerRoutes.partner.users.byId(userId), {
        method: 'DELETE',
      }, partnerEndpointSchemas.deleteUser.response)
    },

    deleteSite(siteId: string) {
      return request<{ success: boolean }>(partnerRoutes.sites.byId(siteId), {
        method: 'DELETE',
      })
    },

    getAnalysisSources(siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: SearchTypeOptions & SourceRangeOptions) {
      return request<GscdumpAnalysisSourcesResponse>(partnerRoutes.sites.analysisSources(siteId), {
        query: tablesQuery(tables, options),
      }, partnerEndpointSchemas.getAnalysisSources.response)
    },

    // When `userId` is passed, derive sync status from a single lifecycle
    // round-trip (saves a request when the caller already wanted both). Falls
    // back to the dedicated sync-status endpoint otherwise. Throws `not-found`
    // when the lifecycle response doesn't include the requested site.
    async getSiteSyncStatus(siteId: string, userId?: string): Promise<GscdumpSyncStatusResponse> {
      return unwrapResult(await getSiteSyncStatusResult(siteId, userId), partnerErrorToException)
    },

    getData(siteId: string, state: BuilderState, queryOptions?: DataQueryOptions) {
      if (shouldValidate('request')) {
        partnerEndpointSchemas.getData.state.parse(state)
        partnerEndpointSchemas.getData.options.parse(queryOptions)
      }
      return request<GscdumpDataResponse>(partnerRoutes.sites.data(siteId), {
        query: dataQuery(state, queryOptions),
      }, partnerEndpointSchemas.getData.response)
    },

    getDataDetail(siteId: string, state: BuilderState, queryOptions?: DataDetailOptions) {
      if (shouldValidate('request')) {
        partnerEndpointSchemas.getDataDetail.state.parse(state)
        partnerEndpointSchemas.getDataDetail.options.parse(queryOptions)
      }
      return request<GscdumpDataDetailResponse>(partnerRoutes.sites.dataDetail(siteId), {
        query: dataDetailQuery(state, queryOptions),
      }, partnerEndpointSchemas.getDataDetail.response)
    },

    getAnalysis(siteId: string, params: GscdumpAnalysisParams) {
      assertAnalysisParams(params)
      const query = shouldValidate('request') ? partnerEndpointSchemas.getAnalysis.query.parse(params) : params
      return request<GscdumpAnalysisResponse>(partnerRoutes.sites.analysis(siteId), {
        query: analysisQuery(query),
      }, partnerEndpointSchemas.getAnalysis.response)
    },

    getSitemaps(siteId: string) {
      return request<GscdumpSitemapsResponse>(partnerRoutes.sites.sitemaps(siteId), {}, partnerEndpointSchemas.getSitemaps.response)
    },

    getSitemapChanges(siteId: string, days = 28) {
      return request<GscdumpSitemapChangesResponse>(partnerRoutes.sites.sitemapChanges(siteId), {
        query: { days },
      }, partnerEndpointSchemas.getSitemapChanges.response)
    },

    submitSitemap(siteId: string, sitemapUrl: string, action: 'submit' | 'delete' = 'submit') {
      return request<{ success: boolean, action: 'submitted' | 'deleted', sitemapUrl: string }>(partnerRoutes.sites.sitemaps(siteId), {
        method: 'POST',
        body: { sitemapUrl, action },
      })
    },

    refreshSitemaps(siteId: string) {
      return request<{ success: boolean, action: 'refreshed', sitemapCount: number, changed: boolean }>(partnerRoutes.sites.sitemaps(siteId), {
        method: 'POST',
        body: { action: 'refresh' },
      })
    },

    getIndexing(siteId: string, days = 28) {
      return request<GscdumpIndexingResponse>(partnerRoutes.sites.indexing(siteId), {
        query: { days },
      }, partnerEndpointSchemas.getIndexing.response)
    },

    getIndexingUrls(siteId: string, params: IndexingUrlsParams = {}) {
      const parsed = shouldValidate('request') ? partnerEndpointSchemas.getIndexingUrls.query.parse(params) : params
      return request<GscdumpIndexingUrlsResponse>(partnerRoutes.sites.indexingUrls(siteId), {
        query: indexingUrlsQuery(parsed),
      }, partnerEndpointSchemas.getIndexingUrls.response)
    },

    getIndexingDiagnostics(siteId: string) {
      return request<GscdumpIndexingDiagnosticsResponse>(partnerRoutes.sites.indexingDiagnostics(siteId), {}, partnerEndpointSchemas.getIndexingDiagnostics.response)
    },

    requestIndexingInspect(siteId: string, body: IndexingInspectRequest) {
      const parsed = shouldValidate('request') ? partnerEndpointSchemas.getIndexingInspect.body.parse(body) : body
      return request<IndexingInspectResponse | IndexingInspectRateLimited>(partnerRoutes.sites.indexingInspect(siteId), {
        method: 'POST',
        body: parsed,
      }, partnerEndpointSchemas.getIndexingInspect.response)
    },

    getUserSettings() {
      return request<GscdumpUserSettings>(partnerRoutes.settings.user, {}, partnerEndpointSchemas.getUserSettings.response)
    },

    patchUserSettings(body: Partial<GscdumpUserSettings>) {
      const parsed = shouldValidate('request') ? partnerEndpointSchemas.patchUserSettings.body.parse(body) : body
      return request<GscdumpUserSettings>(partnerRoutes.settings.user, {
        method: 'PATCH',
        body: parsed,
      }, partnerEndpointSchemas.patchUserSettings.response)
    },

    recoverPermission(siteId: string) {
      return request<GscdumpPermissionRecovery>(partnerRoutes.sites.recoverPermission(siteId), {
        method: 'POST',
      }, partnerEndpointSchemas.recoverPermission.response)
    },

    getTopAssociation(siteId: string, params: GscdumpTopAssociationParams) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getTopAssociation.query.parse(params) : params
      return request<GscdumpTopAssociationResponse>(partnerRoutes.sites.topAssociation(siteId), {
        query: query as unknown as Record<string, unknown>,
      }, partnerEndpointSchemas.getTopAssociation.response)
    },

    getKeywordSparklines(siteId: string, params: GscdumpKeywordSparklinesParams) {
      const withSearchType = { ...params, searchType: params.searchType ?? DEFAULT_SEARCH_TYPE }
      const body = shouldValidate('request') ? partnerEndpointSchemas.getKeywordSparklines.body.parse(withSearchType) : withSearchType
      return request<GscdumpKeywordSparklinesResponse>(partnerRoutes.sites.keywordSparklines(siteId), {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.getKeywordSparklines.response)
    },

    getQueryTrend(siteId: string, params: GscdumpQueryTrendParams) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getQueryTrend.query.parse(params) : params
      return request<GscdumpQueryTrendResponse>(partnerRoutes.sites.queryTrend(siteId), {
        query: queryTrendQuery(query),
      }, partnerEndpointSchemas.getQueryTrend.response)
    },

    getPageTrend(siteId: string, params: GscdumpPageTrendParams) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getPageTrend.query.parse(params) : params
      return request<GscdumpPageTrendResponse>(partnerRoutes.sites.pageTrend(siteId), {
        query: pageTrendQuery(query),
      }, partnerEndpointSchemas.getPageTrend.response)
    },

    getCanonicalMismatches(siteId: string) {
      return request<GscdumpCanonicalMismatchesResponse>(
        partnerRoutes.sites.canonicalMismatches(siteId),
        {},
        partnerEndpointSchemas.getCanonicalMismatches.response,
      )
    },

    getContentVelocity<T = unknown>(siteId: string, days?: number) {
      return request<T>(partnerRoutes.sites.contentVelocity(siteId), {
        query: days == null ? undefined : { days },
      })
    },

    getCtrCurve<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.ctrCurve(siteId), { query: dateRangeQuery(query) })
    },

    getDarkTraffic<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.darkTraffic(siteId), { query: dateRangeQuery(query) })
    },

    getDeviceGap<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.deviceGap(siteId), { query: dateRangeQuery(query) })
    },

    getIndexPercent(siteId: string, params: { invisibleLimit?: number, invisibleOffset?: number, orphanLimit?: number } = {}) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getIndexPercent.query.parse(params) : params
      return request<GscdumpIndexPercentResponse>(
        partnerRoutes.sites.indexPercent(siteId),
        { query: query as Record<string, unknown> },
        partnerEndpointSchemas.getIndexPercent.response,
      )
    },

    getKeywordBreadth<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.keywordBreadth(siteId), { query: dateRangeQuery(query) })
    },

    getPositionDistribution<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate('request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.positionDistribution(siteId), { query: dateRangeQuery(query) })
    },

    createTeam(params: CreatePartnerTeamParams) {
      const body = shouldValidate('request') ? partnerEndpointSchemas.createTeam.body.parse(params) : params
      return request(partnerRoutes.teams.create, {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.createTeam.response)
    },

    renameTeam(teamId: string, params: { name: string }) {
      return request(partnerRoutes.teams.byId(teamId), {
        method: 'PATCH',
        body: params,
      })
    },

    deleteTeam(teamId: string) {
      return request(partnerRoutes.teams.byId(teamId), {
        method: 'DELETE',
      })
    },

    listTeamMembers(teamId: string) {
      return request(partnerRoutes.teams.members(teamId), {}, partnerEndpointSchemas.listTeamMembers.response)
    },

    addTeamMember(teamId: string, params: AddPartnerTeamMemberParams) {
      const body = shouldValidate('request') ? partnerEndpointSchemas.addTeamMember.body.parse(params) : params
      return request<{ ok: true, role: string, alreadyExisted?: boolean }>(partnerRoutes.teams.members(teamId), {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.addTeamMember.response)
    },

    updateTeamMemberRole(teamId: string, userId: string, params: { role: AddPartnerTeamMemberParams['role'] }) {
      return request(partnerRoutes.teams.member(teamId, userId), {
        method: 'PATCH',
        body: params,
      })
    },

    removeTeamMember(teamId: string, userId: string) {
      return request(partnerRoutes.teams.member(teamId, userId), {
        method: 'DELETE',
      })
    },

    bindSiteToTeam(userId: string, siteId: string, params: BindPartnerSiteTeamParams) {
      const body = shouldValidate('request') ? partnerEndpointSchemas.bindSiteToTeam.body.parse(params) : params
      return request(partnerRoutes.partner.users.siteTeam(userId, siteId), {
        method: 'PATCH',
        body,
      }, partnerEndpointSchemas.bindSiteToTeam.response)
    },
  }
}

export const createGscdumpClient = createPartnerClient
