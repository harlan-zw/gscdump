import { z } from 'zod'
import { legacyHistoryNoticeSchema } from '../legacy-history'
import { searchTypeSchema } from '../schemas'
import { defineResponseObject } from './http-core'

export const FLEET_SUMMARY_MAX_SITES = 50

export const FLEET_SUMMARY_PERIODS = [
  'last-7d',
  'last-28d',
  'last-30d',
  'last-90d',
  'last-180d',
  'last-365d',
  'mtd',
  'qtd',
  'ytd',
  'last-quarter',
  'custom',
] as const

export const FLEET_SUMMARY_SORT_FIELDS = [
  'clicks',
  'clicksDelta',
  'clicksDeltaPct',
  'impressions',
  'impressionsDelta',
  'impressionsDeltaPct',
  'positionDelta',
] as const

export type FleetSummaryPeriod = typeof FLEET_SUMMARY_PERIODS[number]
export type FleetSummarySortField = typeof FLEET_SUMMARY_SORT_FIELDS[number]
export type FleetSummarySortDir = 'asc' | 'desc'

/** Published deterministic sort formula for Fleet summary responses (ADR-0027). */
export function fleetSummarySortFormula(
  sortBy: FleetSummarySortField,
  sortDir: FleetSummarySortDir,
): string {
  return `Ok Sites ordered by ${sortBy} ${sortDir} (nulls last, tie-break siteUrl asc, siteId asc), followed by non-Ok Sites ordered by siteUrl asc, siteId asc.`
}

export const fleetSummaryV1RequestSchema = z.strictObject({
  period: z.enum(FLEET_SUMMARY_PERIODS).default('last-28d'),
  comparison: z.enum(['none', 'prev-period', 'yoy']).default('prev-period'),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  searchType: searchTypeSchema.default('web'),
  siteIds: z.array(z.string().min(1).max(128)).min(1).max(FLEET_SUMMARY_MAX_SITES).optional(),
  include: z.strictObject({
    indexing: z.boolean().default(false),
    trajectory: z.boolean().default(false),
  }).optional(),
  sortBy: z.enum(FLEET_SUMMARY_SORT_FIELDS).default('clicks'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
}).superRefine((value, context) => {
  if (Boolean(value.startDate) !== Boolean(value.endDate) || (value.period === 'custom' && !value.startDate))
    context.addIssue({ code: 'custom', path: ['startDate'], message: 'Custom windows require both startDate and endDate.' })
  if (value.startDate && value.endDate && value.startDate > value.endDate)
    context.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate must be on or after startDate.' })
})

const dateRangeSchema = z.strictObject({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
})

export const fleetSummaryV1TotalsSchema = z.strictObject({
  clicks: z.number().finite(),
  impressions: z.number().finite(),
  ctr: z.number().finite(),
  position: z.number().finite().nullable(),
})

export const fleetSummaryV1DeltasSchema = z.strictObject({
  clicks: z.number().finite(),
  clicksPct: z.number().finite().nullable(),
  impressions: z.number().finite(),
  impressionsPct: z.number().finite().nullable(),
  ctr: z.number().finite(),
  position: z.number().finite().nullable(),
})

const fleetSummaryIndexingSchema = z.strictObject({
  indexed: z.number().int().nonnegative().nullable(),
  notIndexed: z.number().int().nonnegative().nullable(),
  totalUrls: z.number().int().nonnegative().nullable(),
  indexedPercent: z.number().finite().nullable(),
})

const fleetSummaryTrajectorySchema = z.strictObject({
  peakWeekClicks: z.number().finite().nullable(),
  latestWeekClicks: z.number().finite().nullable(),
  latestToPeakRatio: z.number().finite().nullable(),
  classification: z.string().min(1),
})

const fleetSummarySiteBaseShape = {
  siteId: z.string().min(1),
  siteUrl: z.string().min(1),
  gscProperty: z.string().min(1).nullable(),
  partner: z.string().min(1).nullable(),
  sameSiteUrlAs: z.array(z.string().min(1)),
  syncStatus: z.string().min(1).nullable(),
  oldestDateSynced: z.iso.date().nullable(),
  newestDateSynced: z.iso.date().nullable(),
}

export const fleetSummaryV1SiteSchema = z.discriminatedUnion('_tag', [
  z.strictObject({
    _tag: z.literal('Ok'),
    ...fleetSummarySiteBaseShape,
    coverage: z.strictObject({
      startDate: z.iso.date().nullable(),
      endDate: z.iso.date().nullable(),
      complete: z.boolean(),
      legacyHistory: legacyHistoryNoticeSchema.optional(),
    }),
    totals: fleetSummaryV1TotalsSchema,
    previousTotals: fleetSummaryV1TotalsSchema.optional(),
    deltas: fleetSummaryV1DeltasSchema.optional(),
    indexing: fleetSummaryIndexingSchema.optional(),
    trajectory: fleetSummaryTrajectorySchema.optional(),
  }),
  z.strictObject({
    _tag: z.literal('Empty'),
    ...fleetSummarySiteBaseShape,
    reason: z.string().min(1),
  }),
  z.strictObject({
    _tag: z.literal('NotSynced'),
    ...fleetSummarySiteBaseShape,
    reason: z.string().min(1),
  }),
  z.strictObject({
    _tag: z.literal('Unavailable'),
    ...fleetSummarySiteBaseShape,
    reason: z.string().min(1),
    retryable: z.boolean(),
  }),
])

const deduplicatedTotalsBodyShape = {
  uniqueSiteUrls: z.number().int().nonnegative(),
  includedSiteIds: z.array(z.string().min(1)),
  excludedDuplicateSiteIds: z.array(z.string().min(1)),
  failedSiteIds: z.array(z.string().min(1)),
  totals: fleetSummaryV1TotalsSchema,
  previousTotals: fleetSummaryV1TotalsSchema.optional(),
  deltas: fleetSummaryV1DeltasSchema.optional(),
}

export const fleetSummaryV1DeduplicatedTotalsSchema = z.discriminatedUnion('_tag', [
  z.strictObject({
    _tag: z.literal('Complete'),
    ...deduplicatedTotalsBodyShape,
  }),
  z.strictObject({
    _tag: z.literal('Partial'),
    ...deduplicatedTotalsBodyShape,
  }),
])

/** Evidence only: raw per-Site totals, deltas, coverage, and deduplicated Fleet totals. */
export const fleetSummaryV1DataSchemas = defineResponseObject({
  window: dateRangeSchema.extend({
    days: z.number().int().positive(),
    comparison: dateRangeSchema.optional(),
  }),
  searchType: searchTypeSchema,
  sortBy: z.enum(FLEET_SUMMARY_SORT_FIELDS),
  sortDir: z.enum(['asc', 'desc']),
  sortFormula: z.string().min(1),
  sites: z.array(fleetSummaryV1SiteSchema),
  deduplicatedTotals: fleetSummaryV1DeduplicatedTotalsSchema,
})

export type FleetSummaryV1Request = z.input<typeof fleetSummaryV1RequestSchema>
export type FleetSummaryV1ParsedRequest = z.output<typeof fleetSummaryV1RequestSchema>
export type FleetSummaryV1Totals = z.infer<typeof fleetSummaryV1TotalsSchema>
export type FleetSummaryV1Deltas = z.infer<typeof fleetSummaryV1DeltasSchema>
export type FleetSummaryV1Site = z.infer<typeof fleetSummaryV1SiteSchema>
export type FleetSummaryV1DeduplicatedTotals = z.infer<typeof fleetSummaryV1DeduplicatedTotalsSchema>
export type FleetSummaryV1Data = z.infer<typeof fleetSummaryV1DataSchemas.client>
