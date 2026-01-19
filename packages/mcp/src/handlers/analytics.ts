import type { GscDb } from '@gscdump/db'
import type { DataProvider } from '@gscdump/query'
import type {
  AnalyticsData,
  Auth,
  ComparisonResult,
  CountryData,
  DatesComparisonResult,
  DeviceData,
  FetchKeywordResult,
  FetchPageResult,
  KeywordData,
  Page,
  PageData,
  SearchAppearanceData,
} from 'gscdump'
import type { z } from 'zod'
import type { fetchAnalyticsInput, fetchKeywordInput, fetchPageInput, HandlerContext, SourceOption } from '../types'
import { createProvider } from '@gscdump/query'
import { fetchAnalyticsWithComparison as fetchAnalyticsCore, fetchSearchAppearanceWithComparison } from 'gscdump'
import { toAnalyticsRange, toPeriod } from '../types'

function getProviderForSource(auth: Auth, db: GscDb | null | undefined, source: SourceOption): DataProvider {
  if (source === 'api')
    return createProvider({ auth })
  if (source === 'db') {
    if (!db)
      throw new Error('Database required for db source')
    return createProvider({ db })
  }
  return db ? createProvider({ auth, db }) : createProvider({ auth })
}

export async function fetchDates(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<DatesComparisonResult> {
  const range = toAnalyticsRange(toPeriod(input.period), input.comparePrevious)
  const provider = getProviderForSource(ctx.auth, ctx.db, ctx.source || 'api')
  return provider.getDatesWithComparison(input.siteUrl, range)
}

export async function fetchDevices(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<ComparisonResult<DeviceData>> {
  const range = toAnalyticsRange(toPeriod(input.period), input.comparePrevious)
  const provider = getProviderForSource(ctx.auth, ctx.db, ctx.source || 'api')
  return provider.getDevicesWithComparison(input.siteUrl, range)
}

export async function fetchCountries(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<ComparisonResult<CountryData>> {
  const range = toAnalyticsRange(toPeriod(input.period), input.comparePrevious)
  const provider = getProviderForSource(ctx.auth, ctx.db, ctx.source || 'api')
  return provider.getCountriesWithComparison(input.siteUrl, range)
}

export async function fetchAllPages(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<Page[]> {
  const range = toAnalyticsRange(toPeriod(input.period), false)
  const provider = getProviderForSource(ctx.auth, ctx.db, ctx.source || 'api')
  return provider.getPages(input.siteUrl, range)
}

export async function fetchPagesComparison(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<ComparisonResult<PageData>> {
  const range = toAnalyticsRange(toPeriod(input.period), input.comparePrevious)
  const provider = getProviderForSource(ctx.auth, ctx.db, ctx.source || 'api')
  return provider.getPagesWithComparison(input.siteUrl, range)
}

export async function fetchKeywords(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<ComparisonResult<KeywordData>> {
  const range = toAnalyticsRange(toPeriod(input.period), input.comparePrevious)
  const provider = getProviderForSource(ctx.auth, ctx.db, ctx.source || 'api')
  return provider.getKeywordsWithComparison(input.siteUrl, range)
}

export async function fetchSearchAppearance(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<ComparisonResult<SearchAppearanceData>> {
  const range = toAnalyticsRange(toPeriod(input.period), input.comparePrevious)
  // SearchAppearance is API-only, no DB equivalent
  return fetchSearchAppearanceWithComparison(ctx.client, input.siteUrl, { ...range, ...input.options })
}

export async function fetchPageDetails(
  input: z.infer<typeof fetchPageInput>,
  ctx: HandlerContext,
): Promise<FetchPageResult> {
  const range = toAnalyticsRange(toPeriod(input.period), false)
  const provider = getProviderForSource(ctx.auth, ctx.db, ctx.source || 'api')
  return provider.getPage(input.siteUrl, range, input.url)
}

export async function fetchKeywordDetails(
  input: z.infer<typeof fetchKeywordInput>,
  ctx: HandlerContext,
): Promise<FetchKeywordResult> {
  const range = toAnalyticsRange(toPeriod(input.period), false)
  const provider = getProviderForSource(ctx.auth, ctx.db, ctx.source || 'api')
  return provider.getKeyword(input.siteUrl, range, input.keyword)
}

export async function fetchAnalyticsSummary(
  input: z.infer<typeof fetchAnalyticsInput>,
  ctx: HandlerContext,
): Promise<ComparisonResult<AnalyticsData>> {
  const range = toAnalyticsRange(toPeriod(input.period), input.comparePrevious)
  // API-only, no DB equivalent for full analytics summary
  return fetchAnalyticsCore(ctx.client, input.siteUrl, { ...range, ...input.options })
}
