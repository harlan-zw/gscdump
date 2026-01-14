import { resolve } from 'node:path'
import { config } from 'dotenv'
import { OAuth2Client } from 'google-auth-library'
import { beforeAll, describe, expect, it } from 'vitest'
import { fetchGscSites, fetchGscSitesWithSitemaps, inspectGscUrl } from '../../packages/gscdump/src/api'

import {
  fetchAnalyticsWithComparison,
  fetchCountriesWithComparison,
  fetchDevicesWithComparison,
  fetchKeywordsWithComparison,
  fetchPagesWithComparison,
} from '../../packages/gscdump/src/searchanalytics'
import { userPeriodRange } from '../../packages/gscdump/src/utils'

config({ path: resolve(__dirname, '../../packages/gscdump/.env.test') })

// Only run when RUN_REAL_CREDENTIALS=true is set explicitly
const shouldRun = process.env.RUN_REAL_CREDENTIALS === 'true'
  && !!process.env.GOOGLE_CLIENT_ID
  && !!process.env.GOOGLE_CLIENT_SECRET
  && !!process.env.GOOGLE_ACCESS_TOKEN

describe.skipIf(!shouldRun)('e2e Real Credentials Tests', () => {
  let auth: OAuth2Client
  let _testSite: string

  beforeAll(async () => {
    auth = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    )

    auth.setCredentials({
      access_token: process.env.GOOGLE_ACCESS_TOKEN,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      token_type: 'Bearer',
    })
  })

  it('should fetch real GSC sites', async () => {
    const sites = await fetchGscSites(auth)

    expect(sites).toBeDefined()
    expect(Array.isArray(sites)).toBe(true)
    expect(sites.length).toBeGreaterThan(0)

    // Store first site for other tests
    _testSite = sites[0]?.siteUrl || 'https://harlanzw.com/'

    // Snapshot the structure (without sensitive data)
    const siteStructure = sites.map(site => ({
      hasUrl: !!site.siteUrl,
      hasDomain: site.siteUrl?.includes('sc-domain:'),
      permissionLevel: site.permissionLevel,
    }))

    expect(siteStructure).toMatchSnapshot()
  })

  it('should fetch sites with sitemaps', async () => {
    const sitesWithSitemaps = await fetchGscSitesWithSitemaps(auth)

    expect(sitesWithSitemaps).toBeDefined()
    expect(Array.isArray(sitesWithSitemaps)).toBe(true)

    // Check structure
    const structure = sitesWithSitemaps.map(site => ({
      hasUrl: !!site.siteUrl,
      permissionLevel: site.permissionLevel,
      sitemapCount: site.sitemaps?.length || 0,
      hasSitemaps: (site.sitemaps?.length || 0) > 0,
    }))

    expect(structure).toMatchSnapshot()
  })

  it('should inspect a real URL', async () => {
    const testUrl = 'https://harlanzw.com/'
    const inspectionUrl = 'https://harlanzw.com/blog'

    const result = await inspectGscUrl(auth, testUrl, inspectionUrl)

    expect(result).toBeDefined()
    expect(result).toHaveProperty('inspection')
    expect(result).toHaveProperty('isIndexed')
    expect(typeof result.isIndexed).toBe('boolean')

    // Snapshot the structure (without sensitive inspection details)
    const structure = {
      hasInspection: !!result.inspection,
      isIndexed: result.isIndexed,
      hasIndexStatus: !!result.inspection?.inspectionResult?.indexStatusResult,
      hasRichResults: !!result.inspection?.inspectionResult?.richResultsResult,
      hasMobileUsability: !!result.inspection?.inspectionResult?.mobileUsabilityResult,
    }

    expect(structure).toMatchSnapshot()
  })

  it('should fetch device analytics with comparison', async () => {
    const site = { siteUrl: 'https://harlanzw.com/', permissionLevel: 'owner' as const }
    const range = userPeriodRange('7d')

    const result = await fetchDevicesWithComparison(auth, site, range)

    expect(result).toBeDefined()
    expect(result).toHaveProperty('current')
    expect(result).toHaveProperty('previous')
    expect(result).toHaveProperty('metadata')
    expect(Array.isArray(result.current)).toBe(true)
    expect(Array.isArray(result.previous)).toBe(true)

    // Snapshot the structure (without actual numbers)
    const structure = {
      currentCount: result.current.length,
      previousCount: result.previous.length,
      hasMetadata: !!result.metadata,
      deviceTypes: result.current.map(d => d.device).sort(),
      fieldsPresent: result.current.length > 0 ? Object.keys(result.current[0]).sort() : [],
    }

    expect(structure).toMatchSnapshot()
  }, 10000) // 10 second timeout for API calls

  it('should fetch country analytics with comparison', async () => {
    const site = { siteUrl: 'https://harlanzw.com/', permissionLevel: 'owner' as const }
    const range = userPeriodRange('7d')

    const result = await fetchCountriesWithComparison(auth, site, range)

    expect(result).toBeDefined()
    expect(result).toHaveProperty('current')
    expect(result).toHaveProperty('previous')
    expect(Array.isArray(result.current)).toBe(true)

    // Snapshot the structure
    const structure = {
      currentCount: result.current.length,
      previousCount: result.previous.length,
      hasCountryNames: result.current.length > 0 && !!result.current[0].country,
      hasKeywordCounts: result.current.length > 0 && typeof result.current[0].keywords === 'number',
      fieldsPresent: result.current.length > 0 ? Object.keys(result.current[0]).sort() : [],
    }

    expect(structure).toMatchSnapshot()
  }, 15000) // Longer timeout as it makes multiple API calls

  it('should fetch comprehensive analytics', async () => {
    const site = { siteUrl: 'https://harlanzw.com/', permissionLevel: 'owner' as const }
    const range = userPeriodRange('7d')

    const analytics = await fetchAnalyticsWithComparison(auth, site, range)
    const pages = await fetchPagesWithComparison(auth, site, range)
    const keywords = await fetchKeywordsWithComparison(auth, site, range)

    // Test analytics
    expect(analytics).toBeDefined()
    expect(analytics.current.length).toBeGreaterThan(0)

    // Test pages
    expect(pages).toBeDefined()
    expect(Array.isArray(pages.current)).toBe(true)

    // Test keywords
    expect(keywords).toBeDefined()
    expect(Array.isArray(keywords.current)).toBe(true)

    // Snapshot structures
    const structures = {
      analytics: {
        currentCount: analytics.current.length,
        hasKeywords: analytics.current.length > 0 && !!analytics.current[0].keywords,
        keywordCount: analytics.current.length > 0 ? analytics.current[0].keywords?.length : 0,
      },
      pages: {
        currentCount: pages.current.length,
        previousCount: pages.previous.length,
        hasUrls: pages.current.length > 0 && !!pages.current[0].page,
        fieldsPresent: pages.current.length > 0 ? Object.keys(pages.current[0]).sort() : [],
      },
      keywords: {
        currentCount: keywords.current.length,
        previousCount: keywords.previous.length,
        hasQueries: keywords.current.length > 0 && !!keywords.current[0].keyword,
        fieldsPresent: keywords.current.length > 0 ? Object.keys(keywords.current[0]).sort() : [],
      },
    }

    expect(structures).toMatchSnapshot()
  }, 20000) // Even longer timeout for multiple API calls
})
