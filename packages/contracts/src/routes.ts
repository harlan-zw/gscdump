export const partnerRoutes = {
  partner: {
    users: {
      lifecycle: (userId: string) => `/partner/users/${encodeURIComponent(userId)}/lifecycle`,
    },
    sites: {
      register: '/partner/sites/register',
      bulkRegister: '/partner/sites/bulk-register',
      verificationToken: '/partner/sites/verification-token',
      addAndVerify: '/partner/sites/add-and-verify',
    },
  },
  users: {
    register: '/users/register',
    tokens: (userId: string) => `/users/${encodeURIComponent(userId)}/tokens`,
    status: (userId: string) => `/users/${encodeURIComponent(userId)}/status`,
    lifecycle: (userId: string) => `/users/${encodeURIComponent(userId)}/lifecycle`,
    sites: (userId: string) => `/users/${encodeURIComponent(userId)}/sites`,
    availableSites: (userId: string) => `/users/${encodeURIComponent(userId)}/available-sites`,
  },
  sites: {
    register: '/sites/register',
    bulkRegister: '/sites/bulk-register',
    byId: (siteId: string) => `/sites/${encodeURIComponent(siteId)}`,
    analysisSources: (siteId: string) => `/sites/${encodeURIComponent(siteId)}/analysis-sources`,
    syncStatus: (siteId: string) => `/sites/${encodeURIComponent(siteId)}/sync-status`,
    data: (siteId: string) => `/sites/${encodeURIComponent(siteId)}/data`,
    dataDetail: (siteId: string) => `/sites/${encodeURIComponent(siteId)}/data/detail`,
    indexing: (siteId: string) => `/sites/${encodeURIComponent(siteId)}/indexing`,
    indexingUrls: (siteId: string) => `/sites/${encodeURIComponent(siteId)}/indexing/urls`,
    indexingDiagnostics: (siteId: string) => `/sites/${encodeURIComponent(siteId)}/indexing/diagnostics`,
  },
  settings: {
    user: '/user/settings',
  },
} as const

export const analyticsRoutes = {
  whoami: '/api/__gsc/whoami',
  sites: '/api/__gsc/sites',
  bulkSources: '/api/__gsc/bulk-sources',
  site: {
    sourceInfo: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/source-info`,
    analysisSources: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/analysis-sources`,
    queryDimSource: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/query-dim-source`,
    analyze: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/analyze`,
    rollup: (siteId: string, rollupId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/rollup/${encodeURIComponent(rollupId)}`,
    backfill: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/backfill`,
    inspections: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/inspections`,
    inspectionHistory: (siteId: string, hash: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/inspections/${encodeURIComponent(hash)}`,
    indexingUrls: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/indexing/urls`,
    indexingDiagnostics: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/indexing/diagnostics`,
    indexingInspect: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/indexing/inspect`,
    countries: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/countries`,
    searchAppearance: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/search-appearance`,
    topAssociation: (siteId: string) => `/api/__gsc/sites/${encodeURIComponent(siteId)}/data/top-association`,
  },
  syncProgress: '/api/sync-progress',
} as const
