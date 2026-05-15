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
import type { ZodTypeAny } from 'zod'
import { partnerEndpointSchemas, partnerRoutes } from '@gscdump/contracts'
import { ofetch } from 'ofetch'
import { toPartnerError } from './errors'

export type PartnerFetch = <T = unknown>(request: string, options?: PartnerFetchOptions) => Promise<T>
export type PartnerHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
export interface PartnerFetchOptions {
  method?: string
  headers?: HeadersInit
  query?: Record<string, unknown>
  body?: unknown
  [key: string]: unknown
}

export interface PartnerClientOptions {
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

type FetchOptions = PartnerFetchOptions

const TRAILING_SLASH_RE = /\/+$/
const LEADING_SLASH_RE = /^\/+/

function trimApiBase(apiBase: string | undefined): string {
  return (apiBase ?? '/api').replace(TRAILING_SLASH_RE, '')
}

function buildPath(apiBase: string, path: string): string {
  if (!apiBase)
    return `/${path.replace(LEADING_SLASH_RE, '')}`
  return `${apiBase}/${path.replace(LEADING_SLASH_RE, '')}`
}

function mergeHeaders(base: HeadersInit | undefined, extra: HeadersInit | undefined): Headers {
  const headers = new Headers(base)
  if (extra) {
    for (const [key, value] of new Headers(extra).entries()) {
      headers.set(key, value)
    }
  }
  return headers
}

async function resolveHeaders(options: PartnerClientOptions): Promise<HeadersInit | undefined> {
  const resolved = typeof options.headers === 'function'
    ? await options.headers()
    : options.headers
  if (!options.apiKey)
    return resolved
  return mergeHeaders(resolved, { 'x-api-key': options.apiKey })
}

function dataQuery(state: BuilderState, options?: DataQueryOptions): Record<string, string> {
  const query: Record<string, string> = { q: JSON.stringify(state) }
  if (options?.comparison)
    query.qc = JSON.stringify(options.comparison)
  if (options?.filter)
    query.filter = options.filter
  return query
}

function dataDetailQuery(state: BuilderState, options?: DataDetailOptions): Record<string, string> {
  const query: Record<string, string> = { q: JSON.stringify(state) }
  if (options?.comparison)
    query.qc = JSON.stringify(options.comparison)
  return query
}

function assertAnalysisParams(params: GscdumpAnalysisParams): void {
  if ((params.preset === 'non-brand' || params.preset === 'brand-only') && !params.brandTerms?.trim()) {
    throw new Error('brandTerms is required for brand/non-brand presets')
  }
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

function tablesQuery(tables: string[] | string | undefined): Record<string, string> | undefined {
  if (!tables)
    return undefined
  return { tables: Array.isArray(tables) ? tables.join(',') : tables }
}

function dateRangeQuery(params: GscdumpDateRangeParams): Record<string, string> {
  return { startDate: params.startDate, endDate: params.endDate }
}

function queryTrendQuery(params: GscdumpQueryTrendParams): Record<string, string> {
  const query: Record<string, string> = {
    startDate: params.startDate,
    endDate: params.endDate,
  }
  if (params.prevStartDate)
    query.prevStartDate = params.prevStartDate
  if (params.prevEndDate)
    query.prevEndDate = params.prevEndDate
  return query
}

function shouldValidate(options: PartnerClientOptions, phase: 'request' | 'response'): boolean {
  return options.validate === true || options.validate === phase
}

function parseWith<T>(schema: ZodTypeAny | undefined, value: T): T {
  return schema ? schema.parse(value) as T : value
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createPartnerClient(options: PartnerClientOptions = {}): PartnerClient {
  const fetchImpl = options.fetch ?? (ofetch as PartnerFetch)
  const apiBase = trimApiBase(options.apiBase)

  async function request<T>(path: string, init: FetchOptions = {}, responseSchema?: ZodTypeAny): Promise<T> {
    const headers = mergeHeaders(await resolveHeaders(options), init.headers)
    try {
      const out = await fetchImpl<T>(buildPath(apiBase, path), {
        ...init,
        headers,
      })
      return shouldValidate(options, 'response') ? parseWith(responseSchema, out) : out
    }
    catch (error) {
      throw toPartnerError(error)
    }
  }

  return {
    registerUser(params: RegisterPartnerUserParams) {
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.registerUser.body.parse(params) : params
      return request<GscdumpUserRegistration>(partnerRoutes.users.register, {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.registerUser.response)
    },

    updateUserTokens(userId: string, params: UpdatePartnerUserTokensParams) {
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.updateUserTokens.body.parse(params) : params
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
      const attempts = waitOptions.attempts ?? 12
      const intervalMs = waitOptions.intervalMs ?? 1000
      let latest: GscdumpUserStatus | null = null
      for (let attempt = 0; attempt < attempts; attempt++) {
        latest = await request<GscdumpUserStatus>(partnerRoutes.users.status(userId))
        if (latest.status === 'ready')
          return latest
        if (attempt < attempts - 1)
          await sleep(intervalMs)
      }
      const err = new Error('gscdump user database is still provisioning') as Error & { data?: unknown }
      err.data = latest
      throw err
    },

    getUserSites(userId: string) {
      return request<{ sites: GscdumpUserSite[] }>(partnerRoutes.users.sites(userId), {}, partnerEndpointSchemas.getUserSites.response)
    },

    getAvailableSites(userId: string) {
      return request<{ sites: GscdumpAvailableSite[] }>(partnerRoutes.users.availableSites(userId), {}, partnerEndpointSchemas.getAvailableSites.response)
    },

    registerSite(params: RegisterPartnerSiteParams) {
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.registerSite.body.parse(params) : params
      return request<GscdumpSiteRegistration>(partnerRoutes.partner.sites.register, {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.registerSite.response)
    },

    bulkRegisterSites(params: BulkRegisterPartnerSitesParams) {
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.bulkRegisterSites.body.parse(params) : params
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

    getAnalysisSources(siteId: string, tables?: string[] | string) {
      return request<GscdumpAnalysisSourcesResponse>(partnerRoutes.sites.analysisSources(siteId), {
        query: tablesQuery(tables),
      }, partnerEndpointSchemas.getAnalysisSources.response)
    },

    getSiteSyncStatus(siteId: string) {
      return request<GscdumpSyncStatusResponse>(partnerRoutes.sites.syncStatus(siteId))
    },

    getData(siteId: string, state: BuilderState, queryOptions?: DataQueryOptions) {
      if (shouldValidate(options, 'request')) {
        partnerEndpointSchemas.getData.state.parse(state)
        partnerEndpointSchemas.getData.options.parse(queryOptions)
      }
      return request<GscdumpDataResponse>(partnerRoutes.sites.data(siteId), {
        query: dataQuery(state, queryOptions),
      }, partnerEndpointSchemas.getData.response)
    },

    getDataDetail(siteId: string, state: BuilderState, queryOptions?: DataDetailOptions) {
      if (shouldValidate(options, 'request')) {
        partnerEndpointSchemas.getDataDetail.state.parse(state)
        partnerEndpointSchemas.getDataDetail.options.parse(queryOptions)
      }
      return request<GscdumpDataDetailResponse>(partnerRoutes.sites.dataDetail(siteId), {
        query: dataDetailQuery(state, queryOptions),
      }, partnerEndpointSchemas.getDataDetail.response)
    },

    getAnalysis(siteId: string, params: GscdumpAnalysisParams) {
      assertAnalysisParams(params)
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getAnalysis.query.parse(params) : params
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
      const parsed = shouldValidate(options, 'request') ? partnerEndpointSchemas.getIndexingUrls.query.parse(params) : params
      return request<GscdumpIndexingUrlsResponse>(partnerRoutes.sites.indexingUrls(siteId), {
        query: indexingUrlsQuery(parsed),
      }, partnerEndpointSchemas.getIndexingUrls.response)
    },

    getIndexingDiagnostics(siteId: string) {
      return request<GscdumpIndexingDiagnosticsResponse>(partnerRoutes.sites.indexingDiagnostics(siteId), {}, partnerEndpointSchemas.getIndexingDiagnostics.response)
    },

    requestIndexingInspect(siteId: string, body: IndexingInspectRequest) {
      const parsed = shouldValidate(options, 'request') ? partnerEndpointSchemas.getIndexingInspect.body.parse(body) : body
      return request<IndexingInspectResponse | IndexingInspectRateLimited>(partnerRoutes.sites.indexingInspect(siteId), {
        method: 'POST',
        body: parsed,
      }, partnerEndpointSchemas.getIndexingInspect.response)
    },

    getUserSettings() {
      return request<GscdumpUserSettings>(partnerRoutes.settings.user, {}, partnerEndpointSchemas.getUserSettings.response)
    },

    patchUserSettings(body: Partial<GscdumpUserSettings>) {
      const parsed = shouldValidate(options, 'request') ? partnerEndpointSchemas.patchUserSettings.body.parse(body) : body
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
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getTopAssociation.query.parse(params) : params
      return request<GscdumpTopAssociationResponse>(partnerRoutes.sites.topAssociation(siteId), {
        query: query as unknown as Record<string, unknown>,
      }, partnerEndpointSchemas.getTopAssociation.response)
    },

    getKeywordSparklines(siteId: string, params: GscdumpKeywordSparklinesParams) {
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.getKeywordSparklines.body.parse(params) : params
      return request<GscdumpKeywordSparklinesResponse>(partnerRoutes.sites.keywordSparklines(siteId), {
        method: 'POST',
        body,
      }, partnerEndpointSchemas.getKeywordSparklines.response)
    },

    getQueryTrend(siteId: string, params: GscdumpQueryTrendParams) {
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getQueryTrend.query.parse(params) : params
      return request<GscdumpQueryTrendResponse>(partnerRoutes.sites.queryTrend(siteId), {
        query: queryTrendQuery(query),
      }, partnerEndpointSchemas.getQueryTrend.response)
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
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.ctrCurve(siteId), { query: dateRangeQuery(query) })
    },

    getDarkTraffic<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.darkTraffic(siteId), { query: dateRangeQuery(query) })
    },

    getDeviceGap<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.deviceGap(siteId), { query: dateRangeQuery(query) })
    },

    getIndexPercent(siteId: string, params: { invisibleLimit?: number, invisibleOffset?: number, orphanLimit?: number } = {}) {
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getIndexPercent.query.parse(params) : params
      return request<GscdumpIndexPercentResponse>(
        partnerRoutes.sites.indexPercent(siteId),
        { query: query as Record<string, unknown> },
        partnerEndpointSchemas.getIndexPercent.response,
      )
    },

    getKeywordBreadth<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.keywordBreadth(siteId), { query: dateRangeQuery(query) })
    },

    getPositionDistribution<T = unknown>(siteId: string, params: GscdumpDateRangeParams) {
      const query = shouldValidate(options, 'request') ? partnerEndpointSchemas.getDateRangeInsight.query.parse(params) : params
      return request<T>(partnerRoutes.sites.positionDistribution(siteId), { query: dateRangeQuery(query) })
    },

    createTeam(params: CreatePartnerTeamParams) {
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.createTeam.body.parse(params) : params
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
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.addTeamMember.body.parse(params) : params
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
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.bindSiteToTeam.body.parse(params) : params
      return request(partnerRoutes.partner.users.siteTeam(userId, siteId), {
        method: 'PATCH',
        body,
      }, partnerEndpointSchemas.bindSiteToTeam.response)
    },
  }
}

export const createGscdumpClient = createPartnerClient
