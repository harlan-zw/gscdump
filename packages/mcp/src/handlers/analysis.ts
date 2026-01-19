import type { GscDb } from '@gscdump/db'
import type { CannibalizationResult, DataProvider, DecayResult, MoversResult, StrikingDistanceResult, ZeroClickResult } from '@gscdump/query'
import type { Auth, YoYComparisonResult } from 'gscdump'
import type { z } from 'zod'
import type {
  cannibalizationInput,
  contentDecayInput,
  HandlerContext,
  moversAndShakersInput,
  Period,
  SourceOption,
  strikingDistanceInput,
  yoyComparisonInput,
  zeroClickInput,
} from '../types'
import {
  createProvider,
  fetchCannibalizationAnalysis,
  fetchDecayAnalysis,
  fetchMoversAnalysis,
  fetchStrikingDistanceAnalysis,
  fetchZeroClickAnalysis,
} from '@gscdump/query'
import dayjs from 'dayjs'
import { fetchYoYComparison as gscFetchYoY } from 'gscdump'
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

/** Default to last 28 days if no period specified */
function defaultPeriod(): Period {
  const end = dayjs().subtract(3, 'day')
  const start = end.subtract(28, 'day')
  return {
    start: start.format('YYYY-MM-DD'),
    end: end.format('YYYY-MM-DD'),
  }
}

/** Build range with comparison period for decay (requires longer lookback) */
function buildDecayRange(period?: Period, lookbackDays = 365) {
  const p = period || defaultPeriod()
  const start = typeof p.start === 'string' ? p.start : p.start.toISOString().split('T')[0]
  const end = typeof p.end === 'string' ? p.end : p.end.toISOString().split('T')[0]

  const prevEnd = dayjs(start).subtract(1, 'day')
  const prevStart = prevEnd.subtract(lookbackDays, 'day')

  return {
    period: { start, end },
    prevPeriod: {
      start: prevStart.format('YYYY-MM-DD'),
      end: prevEnd.format('YYYY-MM-DD'),
    },
  }
}

/** Build range with comparison period for movers */
function buildMoversRange(period?: Period, comparePeriod?: Period) {
  // Default period is last 7 days
  const p = period || (() => {
    const end = dayjs().subtract(3, 'day')
    const start = end.subtract(7, 'day')
    return {
      start: start.format('YYYY-MM-DD'),
      end: end.format('YYYY-MM-DD'),
    }
  })()

  const start = typeof p.start === 'string' ? p.start : p.start.toISOString().split('T')[0]
  const end = typeof p.end === 'string' ? p.end : p.end.toISOString().split('T')[0]
  const periodDays = dayjs(end).diff(dayjs(start), 'day')

  // Compare period defaults to 4 weeks before
  const cp = comparePeriod || (() => {
    const prevEnd = dayjs(start).subtract(1, 'day')
    const prevStart = prevEnd.subtract(periodDays, 'day')
    return {
      start: prevStart.format('YYYY-MM-DD'),
      end: prevEnd.format('YYYY-MM-DD'),
    }
  })()

  return {
    period: { start, end },
    prevPeriod: {
      start: typeof cp.start === 'string' ? cp.start : cp.start.toISOString().split('T')[0],
      end: typeof cp.end === 'string' ? cp.end : cp.end.toISOString().split('T')[0],
    },
  }
}

export async function detectCannibalization(
  input: z.infer<typeof cannibalizationInput>,
  ctx: HandlerContext,
): Promise<CannibalizationResult[]> {
  const range = toAnalyticsRange(
    input.period ? toPeriod(input.period) : defaultPeriod(),
    false,
  )

  const provider = getProviderForSource(ctx.auth, ctx.db, input.source ?? ctx.source ?? 'auto')

  return fetchCannibalizationAnalysis(provider, input.siteUrl, range, {
    minImpressions: input.minImpressions,
    maxPositionSpread: input.maxPositionSpread,
    minPages: input.minPages,
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
  })
}

export async function findStrikingDistance(
  input: z.infer<typeof strikingDistanceInput>,
  ctx: HandlerContext,
): Promise<StrikingDistanceResult[]> {
  const range = toAnalyticsRange(
    input.period ? toPeriod(input.period) : defaultPeriod(),
    false,
  )

  const provider = getProviderForSource(ctx.auth, ctx.db, input.source ?? ctx.source ?? 'auto')

  return fetchStrikingDistanceAnalysis(provider, input.siteUrl, range, {
    minPosition: input.minPosition,
    maxPosition: input.maxPosition,
    minImpressions: input.minImpressions,
    maxCtr: input.maxCtr,
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
  })
}

export async function fetchYoYComparison(
  input: z.infer<typeof yoyComparisonInput>,
  ctx: HandlerContext,
): Promise<YoYComparisonResult> {
  // YoY comparison is API-only for now (requires year-apart comparison)
  return gscFetchYoY(ctx.client, input.siteUrl, {
    period: input.period ? toPeriod(input.period) : undefined,
  })
}

export async function analyzeMoversAndShakers(
  input: z.infer<typeof moversAndShakersInput>,
  ctx: HandlerContext,
): Promise<MoversResult> {
  const range = buildMoversRange(
    input.period ? toPeriod(input.period) : undefined,
    input.comparePeriod ? toPeriod(input.comparePeriod) : undefined,
  )

  const provider = getProviderForSource(ctx.auth, ctx.db, input.source ?? ctx.source ?? 'auto')

  return fetchMoversAnalysis(provider, input.siteUrl, range, {
    changeThreshold: input.changeThreshold,
    minImpressions: input.minImpressions,
    sortBy: input.sortBy,
  })
}

export async function detectContentDecay(
  input: z.infer<typeof contentDecayInput>,
  ctx: HandlerContext,
): Promise<DecayResult[]> {
  const range = buildDecayRange(
    input.period ? toPeriod(input.period) : undefined,
    input.lookbackDays,
  )

  const provider = getProviderForSource(ctx.auth, ctx.db, input.source ?? ctx.source ?? 'auto')

  return fetchDecayAnalysis(provider, input.siteUrl, range, {
    minPreviousClicks: input.minPreviousClicks,
    threshold: input.threshold,
    sortBy: input.sortBy,
  })
}

export async function findZeroClickQueries(
  input: z.infer<typeof zeroClickInput>,
  ctx: HandlerContext,
): Promise<ZeroClickResult[]> {
  const range = toAnalyticsRange(
    input.period ? toPeriod(input.period) : defaultPeriod(),
    false,
  )

  const provider = getProviderForSource(ctx.auth, ctx.db, input.source ?? ctx.source ?? 'auto')

  return fetchZeroClickAnalysis(provider, input.siteUrl, range, {
    minImpressions: input.minImpressions,
    maxCtr: input.maxCtr,
    maxPosition: input.maxPosition,
  })
}
