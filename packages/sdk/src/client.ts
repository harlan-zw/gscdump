import type {
  AddPartnerTeamMemberParams,
  BindPartnerSiteTeamParams,
  BindPartnerTeamCatalogParams,
  BindPartnerTeamCatalogResponse,
  BuilderStateWire,
  BulkRegisterPartnerSitesParams,
  BulkRegisterPartnerSitesResponse,
  CreatePartnerTeamParams,
  DataDetailOptions,
  DataQueryOptions,
  DeletePartnerUserResponse,
  GscAddAndVerifyResponse,
  GscdumpAnalysisSourcesResponse,
  GscdumpAvailableSite,
  GscdumpCanonicalMismatchesResponse,
  GscdumpDataDetailResponse,
  GscdumpDataResponse,
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
  GscdumpSiteIntIdCrosswalkResponse,
  GscdumpSiteRegistration,
  GscdumpSyncStatusResponse,
  GscdumpTeamCatalogRef,
  GscdumpTeamMemberRow,
  GscdumpTeamRow,
  GscdumpTopAssociationParams,
  GscdumpTopAssociationResponse,
  GscdumpUserRegistration,
  GscdumpUserSettings,
  GscdumpUserSite,
  GscdumpUserStatus,
  GscdumpUserTokenUpdate,
  GscVerificationRequest,
  GscVerificationTokenResponse,
  IndexingDiagnosticsParams,
  IndexingInspectRateLimited,
  IndexingInspectRequest,
  IndexingInspectResponse,
  IndexingUrlsParams,
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
  dataDetailQuery,
  dataQuery,
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

/** Hosted partner transport exposed by `@gscdump/sdk`. */
export interface PartnerClient {
  registerUser: (params: RegisterPartnerUserParams) => Promise<GscdumpUserRegistration>
  updateUserTokens: (userId: string, params: UpdatePartnerUserTokensParams) => Promise<GscdumpUserTokenUpdate>
  getUserStatus: (userId: string) => Promise<GscdumpUserStatus>
  getUserLifecycle: (userId: string) => Promise<PartnerLifecycleResponse>
  waitForUserReady: (userId: string, options?: { attempts?: number, intervalMs?: number }) => Promise<GscdumpUserStatus>
  waitForUserLifecycleReady: (userId: string, options?: { attempts?: number, intervalMs?: number }) => Promise<PartnerLifecycleResponse>
  getUserSites: (userId: string) => Promise<{ sites: GscdumpUserSite[] }>
  getAvailableSites: (userId: string) => Promise<{ sites: GscdumpAvailableSite[] }>
  getUserSiteIntIdCrosswalk: (userId: string) => Promise<GscdumpSiteIntIdCrosswalkResponse>
  registerSite: (params: RegisterPartnerSiteParams) => Promise<GscdumpSiteRegistration>
  bulkRegisterSites: (params: BulkRegisterPartnerSitesParams) => Promise<BulkRegisterPartnerSitesResponse>
  requestSiteVerificationToken: (params: GscVerificationRequest) => Promise<GscVerificationTokenResponse>
  addAndVerifySite: (params: GscVerificationRequest) => Promise<GscAddAndVerifyResponse>
  deleteUser: (userId: string) => Promise<DeletePartnerUserResponse>
  deleteSite: (siteId: string) => Promise<{ success: boolean }>
  getAnalysisSources: (siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: SearchTypeOptions & SourceRangeOptions) => Promise<GscdumpAnalysisSourcesResponse>
  getSiteSyncStatus: (siteId: string, userId?: string) => Promise<GscdumpSyncStatusResponse>
  getData: (siteId: string, state: BuilderStateWire, options?: DataQueryOptions) => Promise<GscdumpDataResponse>
  getDataDetail: (siteId: string, state: BuilderStateWire, options?: DataDetailOptions) => Promise<GscdumpDataDetailResponse>
  getIndexing: (siteId: string, days?: number) => Promise<GscdumpIndexingResponse>
  getIndexingUrls: (siteId: string, params?: IndexingUrlsParams) => Promise<GscdumpIndexingUrlsResponse>
  getIndexingDiagnostics: (siteId: string, params?: IndexingDiagnosticsParams) => Promise<GscdumpIndexingDiagnosticsResponse>
  requestIndexingInspect: (siteId: string, body: IndexingInspectRequest) => Promise<IndexingInspectResponse | IndexingInspectRateLimited>
  getUserSettings: () => Promise<GscdumpUserSettings>
  patchUserSettings: (body: Partial<GscdumpUserSettings>) => Promise<GscdumpUserSettings>
  recoverPermission: (siteId: string) => Promise<GscdumpPermissionRecovery>
  getTopAssociation: (siteId: string, params: GscdumpTopAssociationParams) => Promise<GscdumpTopAssociationResponse>
  getKeywordSparklines: (siteId: string, params: GscdumpKeywordSparklinesParams) => Promise<GscdumpKeywordSparklinesResponse>
  getQueryTrend: (siteId: string, params: GscdumpQueryTrendParams) => Promise<GscdumpQueryTrendResponse>
  getPageTrend: (siteId: string, params: GscdumpPageTrendParams) => Promise<GscdumpPageTrendResponse>
  getCanonicalMismatches: (siteId: string) => Promise<GscdumpCanonicalMismatchesResponse>
  getIndexPercent: (siteId: string, params?: { invisibleLimit?: number, invisibleOffset?: number, orphanLimit?: number }) => Promise<GscdumpIndexPercentResponse>
  createTeam: (params: CreatePartnerTeamParams) => Promise<{ team: GscdumpTeamRow }>
  renameTeam: (teamId: string, params: { name: string }) => Promise<{ ok: true, name: string }>
  deleteTeam: (teamId: string) => Promise<{ ok: true }>
  listTeamMembers: (teamId: string) => Promise<{ members: GscdumpTeamMemberRow[] }>
  addTeamMember: (teamId: string, params: AddPartnerTeamMemberParams) => Promise<{ ok: true, role: string, alreadyExisted?: boolean }>
  updateTeamMemberRole: (teamId: string, userId: string, params: { role: GscdumpTeamMemberRow['role'] }) => Promise<{ ok: true, role: string }>
  removeTeamMember: (teamId: string, userId: string) => Promise<{ ok: true }>
  bindSiteToTeam: (userId: string, siteId: string, params: BindPartnerSiteTeamParams) => Promise<{ ok: true, teamId: string | null }>
  getTeamCatalog: (teamId: string) => Promise<GscdumpTeamCatalogRef>
  bindTeamCatalog: (teamId: string, params: BindPartnerTeamCatalogParams) => Promise<BindPartnerTeamCatalogResponse>
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

    getUserSiteIntIdCrosswalk(userId: string) {
      return request<GscdumpSiteIntIdCrosswalkResponse>(
        endpoints.getUserSiteIntIdCrosswalk.path(userId),
        { method: endpoints.getUserSiteIntIdCrosswalk.method },
        endpoints.getUserSiteIntIdCrosswalk.response,
      )
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

    requestSiteVerificationToken(params: GscVerificationRequest) {
      const body = shouldValidate('request') ? endpoints.requestSiteVerificationToken.body.parse(params) : params
      return request<GscVerificationTokenResponse>(endpoints.requestSiteVerificationToken.path, {
        method: endpoints.requestSiteVerificationToken.method,
        body,
      }, endpoints.requestSiteVerificationToken.response)
    },

    addAndVerifySite(params: GscVerificationRequest) {
      const body = shouldValidate('request') ? endpoints.addAndVerifySite.body.parse(params) : params
      return request<GscAddAndVerifyResponse>(endpoints.addAndVerifySite.path, {
        method: endpoints.addAndVerifySite.method,
        body,
      }, endpoints.addAndVerifySite.response)
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

    getData(siteId: string, state: BuilderStateWire, queryOptions?: DataQueryOptions) {
      if (shouldValidate('request')) {
        endpoints.getData.state.parse(state)
        endpoints.getData.options.parse(queryOptions)
      }
      return request<GscdumpDataResponse>(endpoints.getData.path(siteId), {
        method: endpoints.getData.method,
        query: dataQuery(state, queryOptions),
      }, endpoints.getData.response)
    },

    getDataDetail(siteId: string, state: BuilderStateWire, queryOptions?: DataDetailOptions) {
      if (shouldValidate('request')) {
        endpoints.getDataDetail.state.parse(state)
        endpoints.getDataDetail.options.parse(queryOptions)
      }
      return request<GscdumpDataDetailResponse>(endpoints.getDataDetail.path(siteId), {
        method: endpoints.getDataDetail.method,
        query: dataDetailQuery(state, queryOptions),
      }, endpoints.getDataDetail.response)
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

    getIndexPercent(siteId: string, params: { invisibleLimit?: number, invisibleOffset?: number, orphanLimit?: number } = {}) {
      const query = shouldValidate('request') ? endpoints.getIndexPercent.query.parse(params) : params
      return request<GscdumpIndexPercentResponse>(
        endpoints.getIndexPercent.path(siteId),
        { method: endpoints.getIndexPercent.method, query: query as Record<string, unknown> },
        endpoints.getIndexPercent.response,
      )
    },

    createTeam(params: CreatePartnerTeamParams) {
      const body = shouldValidate('request') ? endpoints.createTeam.body.parse(params) : params
      return request(endpoints.createTeam.path, {
        method: endpoints.createTeam.method,
        body,
      }, endpoints.createTeam.response)
    },

    renameTeam(teamId: string, params: { name: string }) {
      const body = shouldValidate('request') ? endpoints.renameTeam.body.parse(params) : params
      return request<{ ok: true, name: string }>(endpoints.renameTeam.path(teamId), {
        method: endpoints.renameTeam.method,
        body,
      }, endpoints.renameTeam.response)
    },

    deleteTeam(teamId: string) {
      return request<{ ok: true }>(endpoints.deleteTeam.path(teamId), {
        method: endpoints.deleteTeam.method,
      }, endpoints.deleteTeam.response)
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
      const body = shouldValidate('request') ? endpoints.updateTeamMemberRole.body.parse(params) : params
      return request<{ ok: true, role: AddPartnerTeamMemberParams['role'] }>(endpoints.updateTeamMemberRole.path(teamId, userId), {
        method: endpoints.updateTeamMemberRole.method,
        body,
      }, endpoints.updateTeamMemberRole.response)
    },

    removeTeamMember(teamId: string, userId: string) {
      return request<{ ok: true }>(endpoints.removeTeamMember.path(teamId, userId), {
        method: endpoints.removeTeamMember.method,
      }, endpoints.removeTeamMember.response)
    },

    bindSiteToTeam(userId: string, siteId: string, params: BindPartnerSiteTeamParams) {
      const body = shouldValidate('request') ? endpoints.bindSiteToTeam.body.parse(params) : params
      return request(endpoints.bindSiteToTeam.path(userId, siteId), {
        method: endpoints.bindSiteToTeam.method,
        body,
      }, endpoints.bindSiteToTeam.response)
    },

    getTeamCatalog(teamId: string) {
      return request<GscdumpTeamCatalogRef>(endpoints.getTeamCatalog.path(teamId), {
        method: endpoints.getTeamCatalog.method,
      }, endpoints.getTeamCatalog.response)
    },

    bindTeamCatalog(teamId: string, params: BindPartnerTeamCatalogParams) {
      const body = shouldValidate('request') ? endpoints.bindTeamCatalog.body.parse(params) : params
      return request<BindPartnerTeamCatalogResponse>(endpoints.bindTeamCatalog.path(teamId), {
        method: endpoints.bindTeamCatalog.method,
        body,
      }, endpoints.bindTeamCatalog.response)
    },
  }
}
