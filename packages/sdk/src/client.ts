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
  IndexingDiagnosticsParams,
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
import type { AnalysisSourcesOptions, SearchTypeOptions, SourceRangeOptions } from './hosted-query'
import type { HostedClientOptions, HostedFetch, HostedFetchOptions, HostedHeaders } from './request'
import { partnerEndpoints } from '@gscdump/contracts/partner'
import { err, ok, unwrapResult } from 'gscdump/result'
import { PartnerApiError, partnerErrorToException } from './errors'
import {
  analysisQuery,
  dataDetailQuery,
  dataQuery,
  dateRangeQuery,
  DEFAULT_SEARCH_TYPE,
  indexingDiagnosticsQuery,
  indexingUrlsQuery,
  pageTrendQuery,
  queryTrendQuery,
  tablesQuery,
} from './hosted-query'
import { findLifecycleSite, lifecycleSiteToSyncStatus } from './lifecycle'
import { createHostedRequester } from './request'

export type PartnerFetch = HostedFetch
export type PartnerHeaders = HostedHeaders
export type PartnerFetchOptions = HostedFetchOptions

const endpoints = partnerEndpoints

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
      const result = await requestResult<GscdumpUserStatus>(endpoints.getUserStatus.path(userId), { method: endpoints.getUserStatus.method })
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
      const result = await requestResult<PartnerLifecycleResponse>(endpoints.getUserLifecycle.path(userId), { method: endpoints.getUserLifecycle.method })
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
      return requestResult<GscdumpSyncStatusResponse>(endpoints.getSyncStatus.path(siteId), { method: endpoints.getSyncStatus.method })
    const lifecycle = await requestResult<PartnerLifecycleResponse>(endpoints.getUserLifecycle.path(userId), { method: endpoints.getUserLifecycle.method })
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
      const body = shouldValidate('request') ? endpoints.registerUser.body.parse(params) : params
      return request<GscdumpUserRegistration>(endpoints.registerUser.path, {
        method: endpoints.registerUser.method,
        body,
      }, endpoints.registerUser.response)
    },

    updateUserTokens(userId: string, params: UpdatePartnerUserTokensParams) {
      const body = shouldValidate('request') ? endpoints.updateUserTokens.body.parse(params) : params
      return request<GscdumpUserTokenUpdate>(endpoints.updateUserTokens.path(userId), {
        method: endpoints.updateUserTokens.method,
        body,
      }, endpoints.updateUserTokens.response)
    },

    getUserStatus(userId: string) {
      return request<GscdumpUserStatus>(endpoints.getUserStatus.path(userId), { method: endpoints.getUserStatus.method }, endpoints.getUserStatus.response)
    },

    getUserLifecycle(userId: string) {
      return request<PartnerLifecycleResponse>(endpoints.getUserLifecycle.path(userId), { method: endpoints.getUserLifecycle.method }, endpoints.getUserLifecycle.response)
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
      return request<{ sites: GscdumpUserSite[] }>(endpoints.getUserSites.path(userId), { method: endpoints.getUserSites.method }, endpoints.getUserSites.response)
    },

    getAvailableSites(userId: string) {
      return request<{ sites: GscdumpAvailableSite[] }>(endpoints.getAvailableSites.path(userId), { method: endpoints.getAvailableSites.method }, endpoints.getAvailableSites.response)
    },

    registerSite(params: RegisterPartnerSiteParams) {
      const body = shouldValidate('request') ? endpoints.registerSite.body.parse(params) : params
      return request<GscdumpSiteRegistration>(endpoints.registerSite.path, {
        method: endpoints.registerSite.method,
        body,
      }, endpoints.registerSite.response)
    },

    bulkRegisterSites(params: BulkRegisterPartnerSitesParams) {
      const body = shouldValidate('request') ? endpoints.bulkRegisterSites.body.parse(params) : params
      return request<BulkRegisterPartnerSitesResponse>(endpoints.bulkRegisterSites.path, {
        method: endpoints.bulkRegisterSites.method,
        body,
      }, endpoints.bulkRegisterSites.response)
    },

    deleteUser(userId: string) {
      return request<DeletePartnerUserResponse>(endpoints.deleteUser.path(userId), {
        method: endpoints.deleteUser.method,
      }, endpoints.deleteUser.response)
    },

    deleteSite(siteId: string) {
      return request<{ success: boolean }>(endpoints.deleteSite.path(siteId), {
        method: endpoints.deleteSite.method,
      })
    },

    getAnalysisSources(siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: SearchTypeOptions & SourceRangeOptions) {
      return request<GscdumpAnalysisSourcesResponse>(endpoints.getAnalysisSources.path(siteId), {
        method: endpoints.getAnalysisSources.method,
        query: tablesQuery(tables, options),
      }, endpoints.getAnalysisSources.response)
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
        endpoints.getData.state.parse(state)
        endpoints.getData.options.parse(queryOptions)
      }
      return request<GscdumpDataResponse>(endpoints.getData.path(siteId), {
        method: endpoints.getData.method,
        query: dataQuery(state, queryOptions),
      }, endpoints.getData.response)
    },

    getDataDetail(siteId: string, state: BuilderState, queryOptions?: DataDetailOptions) {
      if (shouldValidate('request')) {
        endpoints.getDataDetail.state.parse(state)
        endpoints.getDataDetail.options.parse(queryOptions)
      }
      return request<GscdumpDataDetailResponse>(endpoints.getDataDetail.path(siteId), {
        method: endpoints.getDataDetail.method,
        query: dataDetailQuery(state, queryOptions),
      }, endpoints.getDataDetail.response)
    },

    getAnalysis(siteId: string, params: GscdumpAnalysisParams) {
      assertAnalysisParams(params)
      const query = shouldValidate('request') ? endpoints.getAnalysis.query.parse(params) : params
      return request<GscdumpAnalysisResponse>(endpoints.getAnalysis.path(siteId), {
        method: endpoints.getAnalysis.method,
        query: analysisQuery(query),
      }, endpoints.getAnalysis.response)
    },

    getSitemaps(siteId: string) {
      return request<GscdumpSitemapsResponse>(endpoints.getSitemaps.path(siteId), { method: endpoints.getSitemaps.method }, endpoints.getSitemaps.response)
    },

    getSitemapChanges(siteId: string, days = 28) {
      return request<GscdumpSitemapChangesResponse>(endpoints.getSitemapChanges.path(siteId), {
        method: endpoints.getSitemapChanges.method,
        query: { days },
      }, endpoints.getSitemapChanges.response)
    },

    submitSitemap(siteId: string, sitemapUrl: string, action: 'submit' | 'delete' = 'submit') {
      return request<{ success: boolean, action: 'submitted' | 'deleted', sitemapUrl: string }>(endpoints.submitSitemap.path(siteId), {
        method: endpoints.submitSitemap.method,
        body: { sitemapUrl, action },
      })
    },

    refreshSitemaps(siteId: string) {
      return request<{ success: boolean, action: 'refreshed', sitemapCount: number, changed: boolean }>(endpoints.refreshSitemaps.path(siteId), {
        method: endpoints.refreshSitemaps.method,
        body: { action: 'refresh' },
      })
    },

    getIndexing(siteId: string, days = 28) {
      return request<GscdumpIndexingResponse>(endpoints.getIndexing.path(siteId), {
        method: endpoints.getIndexing.method,
        query: { days },
      }, endpoints.getIndexing.response)
    },

    getIndexingUrls(siteId: string, params: IndexingUrlsParams = {}) {
      const parsed = shouldValidate('request') ? endpoints.getIndexingUrls.query.parse(params) : params
      return request<GscdumpIndexingUrlsResponse>(endpoints.getIndexingUrls.path(siteId), {
        method: endpoints.getIndexingUrls.method,
        query: indexingUrlsQuery(parsed),
      }, endpoints.getIndexingUrls.response)
    },

    getIndexingDiagnostics(siteId: string, params: IndexingDiagnosticsParams = {}) {
      const parsed = shouldValidate('request') ? endpoints.getIndexingDiagnostics.query.parse(params) : params
      return request<GscdumpIndexingDiagnosticsResponse>(endpoints.getIndexingDiagnostics.path(siteId), {
        method: endpoints.getIndexingDiagnostics.method,
        query: indexingDiagnosticsQuery(parsed),
      }, endpoints.getIndexingDiagnostics.response)
    },

    requestIndexingInspect(siteId: string, body: IndexingInspectRequest) {
      const parsed = shouldValidate('request') ? endpoints.requestIndexingInspect.body.parse(body) : body
      return request<IndexingInspectResponse | IndexingInspectRateLimited>(endpoints.requestIndexingInspect.path(siteId), {
        method: endpoints.requestIndexingInspect.method,
        body: parsed,
      }, endpoints.requestIndexingInspect.response)
    },

    getUserSettings() {
      return request<GscdumpUserSettings>(endpoints.getUserSettings.path, { method: endpoints.getUserSettings.method }, endpoints.getUserSettings.response)
    },

    patchUserSettings(body: Partial<GscdumpUserSettings>) {
      const parsed = shouldValidate('request') ? endpoints.patchUserSettings.body.parse(body) : body
      return request<GscdumpUserSettings>(endpoints.patchUserSettings.path, {
        method: endpoints.patchUserSettings.method,
        body: parsed,
      }, endpoints.patchUserSettings.response)
    },

    recoverPermission(siteId: string) {
      return request<GscdumpPermissionRecovery>(endpoints.recoverPermission.path(siteId), {
        method: endpoints.recoverPermission.method,
      }, endpoints.recoverPermission.response)
    },

    getTopAssociation(siteId: string, params: GscdumpTopAssociationParams) {
      const query = shouldValidate('request') ? endpoints.getTopAssociation.query.parse(params) : params
      return request<GscdumpTopAssociationResponse>(endpoints.getTopAssociation.path(siteId), {
        method: endpoints.getTopAssociation.method,
        query: query as unknown as Record<string, unknown>,
      }, endpoints.getTopAssociation.response)
    },

    getKeywordSparklines(siteId: string, params: GscdumpKeywordSparklinesParams) {
      const withSearchType = { ...params, searchType: params.searchType ?? DEFAULT_SEARCH_TYPE }
      const body = shouldValidate('request') ? endpoints.getKeywordSparklines.body.parse(withSearchType) : withSearchType
      return request<GscdumpKeywordSparklinesResponse>(endpoints.getKeywordSparklines.path(siteId), {
        method: endpoints.getKeywordSparklines.method,
        body,
        dedupe: true,
      }, endpoints.getKeywordSparklines.response)
    },

    getQueryTrend(siteId: string, params: GscdumpQueryTrendParams) {
      const query = shouldValidate('request') ? endpoints.getQueryTrend.query.parse(params) : params
      return request<GscdumpQueryTrendResponse>(endpoints.getQueryTrend.path(siteId), {
        method: endpoints.getQueryTrend.method,
        query: queryTrendQuery(query),
      }, endpoints.getQueryTrend.response)
    },

    getPageTrend(siteId: string, params: GscdumpPageTrendParams) {
      const query = shouldValidate('request') ? endpoints.getPageTrend.query.parse(params) : params
      return request<GscdumpPageTrendResponse>(endpoints.getPageTrend.path(siteId), {
        method: endpoints.getPageTrend.method,
        query: pageTrendQuery(query),
      }, endpoints.getPageTrend.response)
    },

    getCanonicalMismatches(siteId: string) {
      return request<GscdumpCanonicalMismatchesResponse>(
        endpoints.getCanonicalMismatches.path(siteId),
        { method: endpoints.getCanonicalMismatches.method },
        endpoints.getCanonicalMismatches.response,
      )
    },

    getContentVelocity<T = unknown>(siteId: string, days?: number) {
      return request<T>(endpoints.getContentVelocity.path(siteId), {
        method: endpoints.getContentVelocity.method,
        query: days == null ? undefined : { days },
      })
    },

    getCtrCurve<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const endpoint = endpoints.getCtrCurve
      const query = shouldValidate('request') ? endpoint.query.parse(params) : params
      return request<T>(endpoint.path(siteId), { method: endpoint.method, query: dateRangeQuery(query) })
    },

    getDarkTraffic<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const endpoint = endpoints.getDarkTraffic
      const query = shouldValidate('request') ? endpoint.query.parse(params) : params
      return request<T>(endpoint.path(siteId), { method: endpoint.method, query: dateRangeQuery(query) })
    },

    getDeviceGap<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const endpoint = endpoints.getDeviceGap
      const query = shouldValidate('request') ? endpoint.query.parse(params) : params
      return request<T>(endpoint.path(siteId), { method: endpoint.method, query: dateRangeQuery(query) })
    },

    getIndexPercent(siteId: string, params: { invisibleLimit?: number, invisibleOffset?: number, orphanLimit?: number } = {}) {
      const query = shouldValidate('request') ? endpoints.getIndexPercent.query.parse(params) : params
      return request<GscdumpIndexPercentResponse>(
        endpoints.getIndexPercent.path(siteId),
        { method: endpoints.getIndexPercent.method, query: query as Record<string, unknown> },
        endpoints.getIndexPercent.response,
      )
    },

    getKeywordBreadth<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const endpoint = endpoints.getKeywordBreadth
      const query = shouldValidate('request') ? endpoint.query.parse(params) : params
      return request<T>(endpoint.path(siteId), { method: endpoint.method, query: dateRangeQuery(query) })
    },

    getPositionDistribution<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const endpoint = endpoints.getPositionDistribution
      const query = shouldValidate('request') ? endpoint.query.parse(params) : params
      return request<T>(endpoint.path(siteId), { method: endpoint.method, query: dateRangeQuery(query) })
    },

    createTeam(params: CreatePartnerTeamParams) {
      const body = shouldValidate('request') ? endpoints.createTeam.body.parse(params) : params
      return request(endpoints.createTeam.path, {
        method: endpoints.createTeam.method,
        body,
      }, endpoints.createTeam.response)
    },

    renameTeam(teamId: string, params: { name: string }) {
      return request(endpoints.renameTeam.path(teamId), {
        method: endpoints.renameTeam.method,
        body: params,
      })
    },

    deleteTeam(teamId: string) {
      return request(endpoints.deleteTeam.path(teamId), {
        method: endpoints.deleteTeam.method,
      })
    },

    listTeamMembers(teamId: string) {
      return request(endpoints.listTeamMembers.path(teamId), { method: endpoints.listTeamMembers.method }, endpoints.listTeamMembers.response)
    },

    addTeamMember(teamId: string, params: AddPartnerTeamMemberParams) {
      const body = shouldValidate('request') ? endpoints.addTeamMember.body.parse(params) : params
      return request<{ ok: true, role: string, alreadyExisted?: boolean }>(endpoints.addTeamMember.path(teamId), {
        method: endpoints.addTeamMember.method,
        body,
      }, endpoints.addTeamMember.response)
    },

    updateTeamMemberRole(teamId: string, userId: string, params: { role: AddPartnerTeamMemberParams['role'] }) {
      return request(endpoints.updateTeamMemberRole.path(teamId, userId), {
        method: endpoints.updateTeamMemberRole.method,
        body: params,
      })
    },

    removeTeamMember(teamId: string, userId: string) {
      return request(endpoints.removeTeamMember.path(teamId, userId), {
        method: endpoints.removeTeamMember.method,
      })
    },

    bindSiteToTeam(userId: string, siteId: string, params: BindPartnerSiteTeamParams) {
      const body = shouldValidate('request') ? endpoints.bindSiteToTeam.body.parse(params) : params
      return request(endpoints.bindSiteToTeam.path(userId, siteId), {
        method: endpoints.bindSiteToTeam.method,
        body,
      }, endpoints.bindSiteToTeam.response)
    },
  }
}

export const createGscdumpClient = createPartnerClient
