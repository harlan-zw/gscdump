import { analyticsRoutes, partnerRoutes } from './routes'
import { analyticsEndpointSchemas, partnerControlEndpointSchemas } from './schemas'

export type HostedEndpointMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST'
export type HostedEndpointPath<TArgs extends unknown[] = unknown[]> = string | ((...args: TArgs) => string)

function defineEndpoint<
  const TMethod extends HostedEndpointMethod,
  const TPath,
  const TSchema extends Record<string, unknown>,
>(method: TMethod, path: TPath, schema: TSchema): { method: TMethod, path: TPath } & TSchema {
  return { method, path, ...schema }
}

const noSchema = {} as const

/** Canonical analytics data-plane endpoint definitions. */
export const analyticsEndpoints = {
  whoami: defineEndpoint('GET', analyticsRoutes.whoami, analyticsEndpointSchemas.analyticsWhoami),
  listSites: defineEndpoint('GET', analyticsRoutes.sites, analyticsEndpointSchemas.analyticsSites),
  getBulkSources: defineEndpoint('GET', analyticsRoutes.bulkSources, analyticsEndpointSchemas.analyticsBulkSources),
  getSourceInfo: defineEndpoint('GET', analyticsRoutes.site.sourceInfo, analyticsEndpointSchemas.analyticsSourceInfo),
  getAnalysisSources: defineEndpoint('GET', analyticsRoutes.site.analysisSources, analyticsEndpointSchemas.analyticsAnalysisSources),
  getQueryDimSource: defineEndpoint('GET', analyticsRoutes.site.queryDimSource, analyticsEndpointSchemas.analyticsQueryDimSource),
  analyze: defineEndpoint('POST', analyticsRoutes.site.analyze, noSchema),
  getRollup: defineEndpoint('GET', analyticsRoutes.site.rollup, analyticsEndpointSchemas.analyticsRollup),
  requestBackfill: defineEndpoint('POST', analyticsRoutes.site.backfill, analyticsEndpointSchemas.analyticsBackfill),
  getInspections: defineEndpoint('GET', analyticsRoutes.site.inspections, analyticsEndpointSchemas.analyticsInspections),
  getInspectionHistory: defineEndpoint('GET', analyticsRoutes.site.inspectionHistory, analyticsEndpointSchemas.analyticsInspectionHistory),
  getIndexingUrls: defineEndpoint('GET', analyticsRoutes.site.indexingUrls, analyticsEndpointSchemas.analyticsIndexingUrls),
  getIndexingDiagnostics: defineEndpoint('GET', analyticsRoutes.site.indexingDiagnostics, analyticsEndpointSchemas.analyticsIndexingDiagnostics),
  requestIndexingInspect: defineEndpoint('POST', analyticsRoutes.site.indexingInspect, analyticsEndpointSchemas.analyticsIndexingInspect),
  getCountries: defineEndpoint('GET', analyticsRoutes.site.countries, analyticsEndpointSchemas.analyticsCountries),
  getSearchAppearance: defineEndpoint('GET', analyticsRoutes.site.searchAppearance, analyticsEndpointSchemas.analyticsSearchAppearance),
} as const

/** Canonical partner control-plane endpoint definitions. */
export const partnerEndpoints = {
  registerUser: defineEndpoint('POST', partnerRoutes.users.register, partnerControlEndpointSchemas.registerUser),
  updateUserTokens: defineEndpoint('PATCH', partnerRoutes.users.tokens, partnerControlEndpointSchemas.updateUserTokens),
  getUserStatus: defineEndpoint('GET', partnerRoutes.users.status, partnerControlEndpointSchemas.getUserStatus),
  getUserLifecycle: defineEndpoint('GET', partnerRoutes.partner.users.lifecycle, partnerControlEndpointSchemas.getUserLifecycle),
  getUserSiteIntIdCrosswalk: defineEndpoint('GET', partnerRoutes.partner.users.siteIntIdCrosswalk, partnerControlEndpointSchemas.getUserSiteIntIdCrosswalk),
  getSyncStatus: defineEndpoint('GET', partnerRoutes.sites.syncStatus, noSchema),
  getUserSites: defineEndpoint('GET', partnerRoutes.users.sites, partnerControlEndpointSchemas.getUserSites),
  getAvailableSites: defineEndpoint('GET', partnerRoutes.users.availableSites, partnerControlEndpointSchemas.getAvailableSites),
  registerSite: defineEndpoint('POST', partnerRoutes.partner.sites.register, partnerControlEndpointSchemas.registerSite),
  bulkRegisterSites: defineEndpoint('POST', partnerRoutes.partner.sites.bulkRegister, partnerControlEndpointSchemas.bulkRegisterSites),
  requestSiteVerificationToken: defineEndpoint('POST', partnerRoutes.partner.sites.verificationToken, partnerControlEndpointSchemas.requestSiteVerificationToken),
  addAndVerifySite: defineEndpoint('POST', partnerRoutes.partner.sites.addAndVerify, partnerControlEndpointSchemas.addAndVerifySite),
  deleteUser: defineEndpoint('DELETE', partnerRoutes.partner.users.byId, partnerControlEndpointSchemas.deleteUser),
  deleteSite: defineEndpoint('DELETE', partnerRoutes.sites.byId, noSchema),
  getAnalysisSources: defineEndpoint('GET', partnerRoutes.sites.analysisSources, partnerControlEndpointSchemas.getAnalysisSources),
  getData: defineEndpoint('GET', partnerRoutes.sites.data, partnerControlEndpointSchemas.getData),
  getDataDetail: defineEndpoint('GET', partnerRoutes.sites.dataDetail, partnerControlEndpointSchemas.getDataDetail),
  getIndexing: defineEndpoint('GET', partnerRoutes.sites.indexing, partnerControlEndpointSchemas.getIndexing),
  getIndexingUrls: defineEndpoint('GET', partnerRoutes.sites.indexingUrls, partnerControlEndpointSchemas.getIndexingUrls),
  getIndexingDiagnostics: defineEndpoint('GET', partnerRoutes.sites.indexingDiagnostics, partnerControlEndpointSchemas.getIndexingDiagnostics),
  requestIndexingInspect: defineEndpoint('POST', partnerRoutes.sites.indexingInspect, partnerControlEndpointSchemas.requestIndexingInspect),
  getUserSettings: defineEndpoint('GET', partnerRoutes.settings.user, partnerControlEndpointSchemas.getUserSettings),
  patchUserSettings: defineEndpoint('PATCH', partnerRoutes.settings.user, partnerControlEndpointSchemas.patchUserSettings),
  recoverPermission: defineEndpoint('POST', partnerRoutes.sites.recoverPermission, partnerControlEndpointSchemas.recoverPermission),
  getTopAssociation: defineEndpoint('GET', partnerRoutes.sites.topAssociation, partnerControlEndpointSchemas.getTopAssociation),
  getKeywordSparklines: defineEndpoint('POST', partnerRoutes.sites.keywordSparklines, partnerControlEndpointSchemas.getKeywordSparklines),
  getQueryTrend: defineEndpoint('GET', partnerRoutes.sites.queryTrend, partnerControlEndpointSchemas.getQueryTrend),
  getPageTrend: defineEndpoint('GET', partnerRoutes.sites.pageTrend, partnerControlEndpointSchemas.getPageTrend),
  getCanonicalMismatches: defineEndpoint('GET', partnerRoutes.sites.canonicalMismatches, partnerControlEndpointSchemas.getCanonicalMismatches),
  getIndexPercent: defineEndpoint('GET', partnerRoutes.sites.indexPercent, partnerControlEndpointSchemas.getIndexPercent),
  createTeam: defineEndpoint('POST', partnerRoutes.teams.create, partnerControlEndpointSchemas.createTeam),
  renameTeam: defineEndpoint('PATCH', partnerRoutes.teams.byId, partnerControlEndpointSchemas.renameTeam),
  deleteTeam: defineEndpoint('DELETE', partnerRoutes.teams.byId, partnerControlEndpointSchemas.deleteTeam),
  listTeamMembers: defineEndpoint('GET', partnerRoutes.teams.members, partnerControlEndpointSchemas.listTeamMembers),
  addTeamMember: defineEndpoint('POST', partnerRoutes.teams.members, partnerControlEndpointSchemas.addTeamMember),
  updateTeamMemberRole: defineEndpoint('PATCH', partnerRoutes.teams.member, partnerControlEndpointSchemas.updateTeamMemberRole),
  removeTeamMember: defineEndpoint('DELETE', partnerRoutes.teams.member, partnerControlEndpointSchemas.removeTeamMember),
  bindSiteToTeam: defineEndpoint('PATCH', partnerRoutes.partner.users.siteTeam, partnerControlEndpointSchemas.bindSiteToTeam),
  getTeamCatalog: defineEndpoint('GET', partnerRoutes.teams.catalog, partnerControlEndpointSchemas.getTeamCatalog),
  bindTeamCatalog: defineEndpoint('POST', partnerRoutes.teams.catalog, partnerControlEndpointSchemas.bindTeamCatalog),
} as const
