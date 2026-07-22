import type { FileResolutionResponse, RegisterPartnerSiteParams } from '../src'
import {
  analyticsRoutes,
  builderStateSchema,
  GSCDUMP_ONBOARDING_CONTRACT_VERSION,
  gscdumpSyncProgressResponseSchema,
  partnerEndpointSchemas,
  partnerRoutes,
  partnerWebhookEnvelopeSchema,
  SEARCH_TYPE_CAPABILITIES,
  searchTypeSchema,
  searchTypeSupportsDimensions,
  searchTypeSupportsQueries,
  VALID_WEBHOOK_EVENTS,
  WEBHOOK_CONTRACT_VERSION,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../src'
import {
  analyticsRoutes as analyticsSurfaceRoutes,
  analyticsEndpointSchemas as analyticsSurfaceSchemas,
} from '../src/analytics'
import {
  partnerEndpoints,
  partnerRoutes as partnerSurfaceRoutes,
  partnerEndpointSchemas as partnerSurfaceSchemas,
} from '../src/partner'

const analysisSourcesResponse: FileResolutionResponse = {
  siteId: 'site_1',
  searchType: 'web',
  range: { start: '2026-05-01', end: '2026-05-07' },
  snapshotVersion: 'snapshot_1',
  generatedAt: '2026-05-11T00:00:00.000Z',
  tables: [{
    table: 'pages',
    mode: 'browser',
    files: [{
      url: '/api/r2-data/pages.parquet?sig=abc',
      bytes: 1234,
      contentHash: 'file_1',
      rowCount: 12,
    }],
    totalBytes: 1234,
    totalRows: 12,
  }],
  eligibilityCeiling: { maxBytes: 150_000_000, maxRows: 10_000_000, maxFiles: 64 },
}

describe('@gscdump/contracts', () => {
  it('models sync-progress partner IDs using the producer UUID/text shape', () => {
    const partnerIdSchema = gscdumpSyncProgressResponseSchema.shape.sites.element.shape.partnerId
    expect(partnerIdSchema.safeParse('partner-uuid').success).toBe(true)
    expect(partnerIdSchema.safeParse(42).success).toBe(false)
  })

  it('exports hosted route metadata and endpoint schemas', () => {
    expect(partnerRoutes.users.register).toBe('/users/register')
    expect(partnerRoutes.partner.sites.register).toBe('/partner/sites/register')
    expect(partnerRoutes.partner.sites.bulkRegister).toBe('/partner/sites/bulk-register')
    expect(partnerRoutes.partner.users.byId('u_1')).toBe('/partner/users/u_1')
    expect(partnerRoutes.sites.data('site_1')).toBe('/sites/site_1/data')
    expect(partnerRoutes.sites.analysisSources('site_1')).toBe('/sites/site_1/analysis-sources')
    expect(analyticsRoutes.sites).toBe('/api/__gsc/sites')
    expect(analyticsRoutes.bulkSources).toBe('/api/__gsc/bulk-sources')
    expect(analyticsRoutes.site.analysisSources('site_1')).toBe('/api/__gsc/sites/site_1/analysis-sources')
    expect(analyticsRoutes.site.queryDimSource('site_1')).toBe('/api/__gsc/sites/site_1/query-dim-source')
    expect(analyticsRoutes.site.rollup('site_1', 'top-pages')).toBe('/api/__gsc/sites/site_1/rollup/top-pages')
    expect(partnerEndpointSchemas.registerSite.body.parse({
      userId: 'user_1',
      siteUrl: 'sc-domain:example.com',
      webhookEvents: ['site.analytics.ready'],
      enabledSearchTypes: ['web', 'discover'],
    })).toMatchObject({ userId: 'user_1' })
    expect(partnerEndpointSchemas.bulkRegisterSites.body.parse({
      userId: 'user_1',
      sites: [{ siteUrl: 'sc-domain:example.com', enabledSearchTypes: ['web', 'news'] }],
    })).toMatchObject({ userId: 'user_1' })
    const typedRegister: RegisterPartnerSiteParams = {
      userId: 'user_1',
      siteUrl: 'sc-domain:example.com',
      enabledSearchTypes: ['web', 'discover'],
    }
    expect(typedRegister.enabledSearchTypes).toEqual(['web', 'discover'])
    expect(partnerEndpointSchemas.getAnalysisSources.response.parse(analysisSourcesResponse)).toMatchObject({
      snapshotVersion: 'snapshot_1',
      tables: [{ table: 'pages', mode: 'browser' }],
    })
    expect(analyticsSurfaceSchemas.analyticsBulkSources.response.parse({
      generatedAt: '2026-05-11T00:00:00.000Z',
      siteCount: 1,
      maxSites: 20,
      results: { site_1: analysisSourcesResponse },
    })).toMatchObject({ siteCount: 1, results: { site_1: { snapshotVersion: 'snapshot_1' } } })
    expect(analyticsSurfaceSchemas.analyticsQueryDimSource.response.parse({
      file: { url: '/query-dim.parquet', bytes: 123, contentHash: 'query-dim-1' },
    })).toMatchObject({ file: { contentHash: 'query-dim-1' } })
    expect(partnerEndpointSchemas.postSitemaps.body.parse({
      action: 'submit',
      sitemapUrl: 'https://example.com/sitemap.xml',
    })).toMatchObject({ action: 'submit' })
    expect(partnerEndpointSchemas.postSitemaps.body.parse({ action: 'refresh' })).toEqual({ action: 'refresh' })
    expect(() => partnerEndpointSchemas.postSitemaps.body.parse({ action: 'submit' })).toThrow()
  })

  it('exposes focused hosted contract subpaths', () => {
    expect(partnerSurfaceRoutes.users.register).toBe(partnerRoutes.users.register)
    expect(partnerSurfaceSchemas.registerSite).toBe(partnerEndpointSchemas.registerSite)
    expect('analyticsWhoami' in partnerSurfaceSchemas).toBe(false)

    expect(analyticsSurfaceRoutes.sites).toBe(analyticsRoutes.sites)
    expect(analyticsSurfaceSchemas.analyticsRollup).toBe(partnerEndpointSchemas.analyticsRollup)
  })

  it('keeps endpoint method, path, and validation metadata together', () => {
    expect(partnerEndpoints.registerUser).toMatchObject({ method: 'POST', path: '/users/register' })
    expect(partnerEndpoints.updateUserTokens.path('user 1')).toBe('/users/user%201/tokens')
    expect(partnerEndpoints.updateUserTokens.body).toBe(partnerSurfaceSchemas.updateUserTokens.body)
    expect(partnerEndpoints.deleteSite).toMatchObject({ method: 'DELETE' })

    expect(partnerEndpoints.postSitemaps).toMatchObject({ method: 'POST' })
    expect(partnerEndpoints.postSitemaps.path('site 1')).toBe('/sites/site%201/sitemaps')
    expect(partnerEndpoints.postSitemaps.body).toBe(partnerSurfaceSchemas.postSitemaps.body)
  })

  it('validates the current webhook envelope contract', () => {
    expect(VALID_WEBHOOK_EVENTS).toContain('site.indexing.ready')
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe('X-GSCDump-Timestamp')
    expect(partnerWebhookEnvelopeSchema.parse({
      contractVersion: WEBHOOK_CONTRACT_VERSION,
      deliveryId: 'whd_1',
      event: 'site.analytics.ready',
      partnerId: 'partner_1',
      userId: 'user_1',
      siteId: 'site_1',
      externalUserId: null,
      externalSiteId: null,
      lifecycleRevision: 1,
      occurredAt: '2026-05-11T00:00:00.000Z',
      data: {
        siteId: 'site_1',
        siteUrl: 'sc-domain:example.com',
        status: 'synced',
        daysSynced: 28,
        failedJobs: 0,
        oldestDateSynced: '2026-04-01',
        newestDateSynced: '2026-04-30',
        timestamp: 1770000000,
      },
    })).toMatchObject({ event: 'site.analytics.ready' })
  })

  it('searchTypeSchema accepts the 6 GSC slices and rejects everything else', () => {
    for (const slice of ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const)
      expect(searchTypeSchema.parse(slice)).toBe(slice)

    // Case-sensitive: 'Discover' is not the same as 'discover'.
    expect(searchTypeSchema.safeParse('Discover').success).toBe(false)
    // Empty string is never a valid slice (the '' sentinel is an internal
    // store-level convention, not a public input).
    expect(searchTypeSchema.safeParse('').success).toBe(false)
    // Whitespace-padded values must round-trip exactly; no trimming.
    expect(searchTypeSchema.safeParse('web ').success).toBe(false)
    // Unknown strings rejected outright.
    expect(searchTypeSchema.safeParse('blogs').success).toBe(false)
    expect(searchTypeSchema.safeParse(undefined).success).toBe(false)
    expect(searchTypeSchema.safeParse(null).success).toBe(false)
  })

  it('sEARCH_TYPE_CAPABILITIES covers every slice and encodes the Discover/Google News limitations', () => {
    // One capability row per schema slice, no extras.
    expect(Object.keys(SEARCH_TYPE_CAPABILITIES).sort()).toEqual([...searchTypeSchema.options].sort())

    // Discover has no query/position/device/country breakdown; Google News
    // only reports clicks/impressions.
    for (const slice of ['discover', 'googleNews'] as const) {
      expect(searchTypeSupportsQueries(slice)).toBe(false)
      expect(searchTypeSupportsDimensions(slice)).toBe(false)
    }
    for (const slice of ['web', 'image', 'video', 'news'] as const) {
      expect(searchTypeSupportsQueries(slice)).toBe(true)
      expect(searchTypeSupportsDimensions(slice)).toBe(true)
    }
  })

  it('builderState contract preserves valid optional searchType', () => {
    expect(builderStateSchema.parse({ dimensions: ['page'], searchType: 'discover' })).toMatchObject({
      searchType: 'discover',
    })
    expect(builderStateSchema.parse({ dimensions: ['page'] }).searchType).toBeUndefined()
    expect(builderStateSchema.safeParse({ dimensions: ['page'], searchType: 'blogs' }).success).toBe(false)
  })

  it('validates lifecycle onboarding responses', () => {
    expect(partnerEndpointSchemas.getUserLifecycle.response.parse({
      contractVersion: GSCDUMP_ONBOARDING_CONTRACT_VERSION,
      userId: 'user_1',
      partnerId: 'partner_1',
      currentTeamId: 'team_1',
      account: {
        status: 'ready',
        grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        missingScopes: [],
        nextAction: 'none',
      },
      sites: [{
        siteId: 'site_1',
        intId: 1001,
        catalogSiteId: 2001,
        externalSiteId: null,
        requestedUrl: 'sc-domain:example.com',
        gscPropertyUrl: 'sc-domain:example.com',
        permissionLevel: 'siteOwner',
        property: { status: 'linked', nextAction: 'none' },
        analytics: {
          status: 'ready',
          progress: { completed: 28, failed: 0, total: 28, percent: 100 },
          queryable: true,
          sourceMode: 'r2',
          syncedRange: { oldest: '2026-04-01', newest: '2026-04-30' },
          nextAction: 'none',
        },
        sitemaps: {
          status: 'ready',
          discoveredCount: 1,
          nextAction: 'none',
        },
        indexing: {
          status: 'ready',
          eligible: true,
          reason: null,
          progress: { completed: 10, failed: 0, total: 10, percent: 100 },
          nextAction: 'none',
        },
        latestError: null,
        lifecycleRevision: 1,
        updatedAt: '2026-05-11T00:00:00.000Z',
      }],
    })).toMatchObject({ userId: 'user_1' })
  })
})
