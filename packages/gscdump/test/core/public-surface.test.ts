import type {
  ApiSitemap,
  InspectUrlIndexResponse,
  PublishUrlNotificationResponse,
  SearchAnalyticsQuery,
  SearchAnalyticsResponse,
  UrlNotificationMetadata,
} from '../../src'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as gscdump from '../../src'
import { progressBar, rowWithMetricDefaults } from '../../src/core/cli-format'
import { daysAgo as daysAgoUtcInternal } from '../../src/core/gsc-dates'
import { daysAgoUtc } from '../../src/dates'
import { daysAgo as daysAgoPst } from '../../src/query'

describe('v1 public surface', () => {
  it('keeps ambiguous and internal-only helpers off the package root', () => {
    expect(gscdump).not.toHaveProperty('daysAgo')
    expect(gscdump).not.toHaveProperty('formatErrorForCli')
    expect(gscdump).not.toHaveProperty('gscdumpApi')
    expect(gscdump).not.toHaveProperty('progressBar')
    expect(gscdump).not.toHaveProperty('rowWithMetricDefaults')
  })

  it('keeps internal helpers available to package modules', () => {
    expect(progressBar(1, 2, 'sync')).toContain('sync')
    expect(rowWithMetricDefaults({ clicks: null })).toMatchObject({ clicks: 0 })
    expect(daysAgoUtc(1)).toBe(daysAgoUtcInternal(1))
    expect(daysAgoPst(1)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('exposes package-owned structural Google wire contracts', () => {
    expectTypeOf<ApiSitemap>().toMatchTypeOf<{
      path?: string | null
      contents?: Array<{ type?: string | null, submitted?: string | null }>
    }>()
    expectTypeOf<SearchAnalyticsQuery>().toMatchTypeOf<{
      startDate?: string | null
      endDate?: string | null
    }>()
    expectTypeOf<SearchAnalyticsResponse>().toMatchTypeOf<{
      rows?: Array<{ keys?: string[] | null, clicks?: number | null }>
    }>()
    expectTypeOf<InspectUrlIndexResponse>().toMatchTypeOf<{
      inspectionResult?: { indexStatusResult?: { verdict?: string | null } }
    }>()
    expectTypeOf<UrlNotificationMetadata>().toMatchTypeOf<{
      latestUpdate?: { notifyTime?: string | null }
    }>()
    expectTypeOf<PublishUrlNotificationResponse>().toMatchTypeOf<{
      urlNotificationMetadata?: UrlNotificationMetadata
    }>()
  })
})
