// GET /api/__gsc/sites/[siteId]/rollup/[id]
//
// Default path (no range): read the newest pre-built JSON envelope from R2
// under `u_<userId>/<siteId>/rollups/<id>__v<builtAt>.json` (written by the
// rollup builder after each sync).
//
// With `?start=&end=`: synthesize at request time so Pages/Queries pages can
// honour a user-selected range on both tiers.
//   - Free → GSC API row query over the window.
//   - Pro  → engine SQL over parquet via R2.
//
// `daily_totals` is range-agnostic (client windows): we return a wide window
// once and let the consumer slice.

import type { RollupEnvelope } from '@gscdump/engine/rollups'
import type { AnalyticsIdentity, AnalyticsSiteInfo } from '@gscdump/nuxt-analytics/types'
import type { H3Event } from 'h3'
import { getAnalyticsEngine } from '@gscdump/nuxt-analytics/internal/engine'
import { googleSearchConsole } from 'gscdump'
import { page as pageDim, query as queryDim } from 'gscdump/query'

const ROLLUP_FILE_RE = /^(?<id>[a-z0-9_]+)__v(?<ts>\d+)\.json$/
const DAILY_TOTALS_WINDOW_DAYS = 90
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface Range { start: string, end: string }

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function parseRange(q: Record<string, unknown>): Range | null {
  const start = typeof q.start === 'string' ? q.start : ''
  const end = typeof q.end === 'string' ? q.end : ''
  if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end))
    return null
  if (end < start)
    return null
  return { start, end }
}

function windowDaysFor(r: Range): number {
  const s = Date.parse(`${r.start}T00:00:00Z`)
  const e = Date.parse(`${r.end}T00:00:00Z`)
  return Math.max(1, Math.round((e - s) / 86400000) + 1)
}

async function synthesizeFree(
  event: H3Event,
  identity: AnalyticsIdentity,
  site: AnalyticsSiteInfo,
  id: string,
  range: Range | null,
): Promise<RollupEnvelope | null> {
  const accessToken = await resolveGscApiAccessToken(event, identity)
  if (!accessToken)
    throw createError({ statusCode: 502, statusMessage: 'no GSC access token available' })
  const client = googleSearchConsole({ accessToken })
  const builtAt = Date.now()

  if (id === 'daily_totals') {
    const dailyRange = range ?? { start: isoDaysAgo(DAILY_TOTALS_WINDOW_DAYS), end: isoDaysAgo(0) }
    const payload = await fetchGscDaily({ client, siteUrl: site.siteUrl, range: dailyRange })
    return { version: 1, id, builtAt, windowDays: null, payload }
  }

  const usedRange = range ?? { start: isoDaysAgo(28 + 3), end: isoDaysAgo(3) }
  const win = windowDaysFor(usedRange)

  if (id === 'top_pages_28d') {
    const rows = await fetchGscTopN({
      client,
      siteUrl: site.siteUrl,
      dimension: pageDim,
      range: usedRange,
      orderByClicksDesc: true,
      limit: 100,
    })
    return {
      version: 1,
      id,
      builtAt,
      windowDays: win,
      payload: rows.map(r => ({ url: r.key, clicks: r.clicks, impressions: r.impressions, sum_position: r.sum_position })),
    }
  }
  if (id === 'top_keywords_28d') {
    const rows = await fetchGscTopN({
      client,
      siteUrl: site.siteUrl,
      dimension: queryDim,
      range: usedRange,
      orderByClicksDesc: true,
      limit: 100,
    })
    return {
      version: 1,
      id,
      builtAt,
      windowDays: win,
      payload: rows.map(r => ({ query: r.key, clicks: r.clicks, impressions: r.impressions, sum_position: r.sum_position })),
    }
  }
  return null
}

// Bounded LRU keyed on (userId, siteId, id, start, end). 60s TTL; isolate-local.
// Every CF isolate warms its cache independently — acceptable because range
// queries are bursty during a single dashboard session.
interface ProCacheEntry { envelope: RollupEnvelope, expiresAt: number }
const PRO_CACHE_MAX = 32
const PRO_CACHE_TTL_MS = 60_000
const proCache = new Map<string, ProCacheEntry>()

function proCacheGet(key: string): RollupEnvelope | null {
  const hit = proCache.get(key)
  if (!hit)
    return null
  if (hit.expiresAt <= Date.now()) {
    proCache.delete(key)
    return null
  }
  proCache.delete(key)
  proCache.set(key, hit)
  return hit.envelope
}

function proCacheSet(key: string, envelope: RollupEnvelope): void {
  if (proCache.size >= PRO_CACHE_MAX) {
    const oldest = proCache.keys().next().value
    if (oldest !== undefined)
      proCache.delete(oldest)
  }
  proCache.set(key, { envelope, expiresAt: Date.now() + PRO_CACHE_TTL_MS })
}

async function synthesizeProWithRange(
  engine: NonNullable<ReturnType<typeof getAnalyticsEngine>>,
  userId: string,
  siteId: string,
  id: string,
  range: Range,
): Promise<RollupEnvelope | null> {
  if (id !== 'top_pages_28d' && id !== 'top_keywords_28d')
    return null

  const cacheKey = `${userId}|${siteId}|${id}|${range.start}|${range.end}`
  const cached = proCacheGet(cacheKey)
  if (cached)
    return cached

  const table = id === 'top_pages_28d' ? 'pages' : 'keywords'
  const urlCol = table === 'pages' ? 'url' : 'query'
  const result = await engine.runSQL({
    ctx: { userId, siteId },
    table,
    fileSets: { FILES: { table } },
    sql: `
      SELECT
        ${urlCol},
        SUM(clicks)::BIGINT AS clicks,
        SUM(impressions)::BIGINT AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date BETWEEN '${range.start}' AND '${range.end}'
      GROUP BY ${urlCol}
      ORDER BY clicks DESC
      LIMIT 100
    `,
  })

  const payload = result.rows.map((r) => {
    const row = r as Record<string, unknown>
    const key = row[urlCol]
    return {
      [urlCol]: String(key ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      sum_position: Number(row.sum_position ?? 0),
    }
  })

  const envelope: RollupEnvelope = {
    version: 1,
    id,
    builtAt: Date.now(),
    windowDays: windowDaysFor(range),
    payload,
  }
  proCacheSet(cacheKey, envelope)
  return envelope
}

async function readLatestFromR2(
  bucket: R2Bucket,
  userId: string,
  siteId: string,
  id: string,
): Promise<RollupEnvelope> {
  const prefix = `u_${userId}/${siteId}/rollups/`
  const listing = await bucket.list({ prefix })
  let newest: { ts: number, key: string } | null = null
  for (const obj of listing.objects) {
    const name = obj.key.slice(prefix.length)
    const m = ROLLUP_FILE_RE.exec(name)
    if (!m?.groups || m.groups.id !== id)
      continue
    const ts = Number(m.groups.ts)
    if (!newest || ts > newest.ts)
      newest = { ts, key: obj.key }
  }
  if (!newest)
    throw createError({ statusCode: 404, statusMessage: `no rollup ${id} under ${prefix}` })
  const obj = await bucket.get(newest.key)
  if (!obj)
    throw createError({ statusCode: 404, statusMessage: `rollup object vanished: ${newest.key}` })
  return JSON.parse(await obj.text()) as RollupEnvelope
}

export default defineEventHandler(async (event) => {
  const siteIdParam = getRouterParam(event, 'siteId') || ''
  const id = getRouterParam(event, 'id') || ''
  if (!siteIdParam || !id)
    throw createError({ statusCode: 400, statusMessage: 'siteId and id required' })

  const identity = await requireIdentity(event)
  const site = await requireSite(event, identity, siteIdParam)

  const range = parseRange(getQuery(event) as Record<string, unknown>)
  setHeader(event, 'Cache-Control', range ? 'private, max-age=30' : 'private, max-age=60')

  if (identity.attrs?.tier !== 'pro') {
    const envelope = await synthesizeFree(event, identity, site, id, range)
    if (!envelope)
      throw createError({ statusCode: 404, statusMessage: `rollup "${id}" has no free-tier equivalent` })
    return envelope
  }

  const env = useAnalyticsEnv(event)
  const engine = getAnalyticsEngine(env, requireDb(event))
  if (range && (id === 'top_pages_28d' || id === 'top_keywords_28d') && engine) {
    const live = await synthesizeProWithRange(engine, identity.userId, site.storageId, id, range).catch((err: Error) => {
      console.warn(`[rollup] pro-tier live synthesis failed for ${id}:`, err.message)
      return null
    })
    if (live)
      return live
  }
  if (!env.R2_DATA)
    throw createError({ statusCode: 500, statusMessage: 'R2_DATA binding missing' })
  return readLatestFromR2(env.R2_DATA, identity.userId, site.storageId, id)
})
