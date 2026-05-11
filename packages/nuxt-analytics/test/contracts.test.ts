import type {
  AnalysisSourcesResponse,
  IndexingDiagnostics,
  IndexingUrlsResponse,
  InspectionHistoryResponse,
  SiteListItem,
  SitemapChangesResponse,
  SitemapHistoryResponse,
  SourceInfoResponse,
} from '../types'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readFixture<T>(name: string): T {
  const url = new URL(`./fixtures/contracts/${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as T
}

describe('@gscdump/nuxt-analytics public response contracts', () => {
  it('locks SiteListItem', () => {
    const item = readFixture<SiteListItem>('site-list-item')
    expect(item).toMatchObject({
      id: 'sc-domain_example.com',
      label: 'sc-domain:example.com',
      propertyType: 'domain',
      readBackend: 'r2',
    })
  })

  it('locks IndexingUrlsResponse', () => {
    const response = readFixture<IndexingUrlsResponse>('indexing-urls')
    expect(response.urls[0]?.url).toBe('https://example.com/docs/')
    expect(response.pagination.hasMore).toBe(false)
    expect(response.meta.issue).toBeNull()
  })

  it('locks IndexingDiagnostics', () => {
    const response = readFixture<IndexingDiagnostics>('indexing-diagnostics')
    expect(response.summary.indexedPercent).toBe(80)
    expect(response.issues[0]?.severity).toBe('warning')
  })

  it('locks SitemapChangesResponse', () => {
    const response = readFixture<SitemapChangesResponse>('sitemap-changes')
    expect(response.summary.period.days).toBe(7)
    expect(response.added[0]?.sitemap).toContain('sitemap.xml')
  })

  it('locks SitemapHistoryResponse', () => {
    const response = readFixture<SitemapHistoryResponse>('sitemap-history')
    expect(response.path).toBe('https://example.com/sitemap.xml')
    expect(response.snapshots[0]?.capturedAt).toBe('2026-05-10T00:00:00.000Z')
  })

  it('locks InspectionHistoryResponse', () => {
    const response = readFixture<InspectionHistoryResponse>('inspection-history')
    expect(response.url).toBe('https://example.com/docs/')
    expect(response.records[0]?.indexStatus).toBe('PASS')
  })

  it('locks AnalysisSourcesResponse', () => {
    const response = readFixture<AnalysisSourcesResponse>('analysis-sources')
    expect(response.tables.pages).toHaveLength(1)
    expect(response.manifestVersion).toContain('r2-manifest')
  })

  it('locks SourceInfoResponse', () => {
    const response = readFixture<SourceInfoResponse>('source-info')
    expect(response.kind).toBe('sql')
    expect(response.capabilities.attachedTables).toBe(true)
    expect(response.browserAttachEligible).toBe(true)
  })
})
