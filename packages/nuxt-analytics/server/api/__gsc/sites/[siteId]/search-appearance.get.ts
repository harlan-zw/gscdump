// GET /api/__gsc/sites/[siteId]/search-appearance?start=&end=
//
// Search-appearance breakdown for a range. Tier branching:
//   - Free  → live GSC API (searchAppearance dimension).
//   - Pro   → engine SQL over R2 parquet (`search_appearance` table).

import type { SearchAppearanceResponse, SearchAppearanceRow } from '@gscdump/nuxt-analytics/types'
import { getAnalyticsEngine } from '@gscdump/nuxt-analytics/internal/engine'
import { googleSearchConsole } from 'gscdump'
import { searchAppearance as searchAppearanceDim } from 'gscdump/query'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default defineEventHandler(async (event): Promise<SearchAppearanceResponse> => {
  const siteIdParam = getRouterParam(event, 'siteId') || ''
  if (!siteIdParam)
    throw createError({ statusCode: 400, statusMessage: 'siteId required' })

  const q = getQuery(event)
  const start = typeof q.start === 'string' ? q.start : ''
  const end = typeof q.end === 'string' ? q.end : ''
  if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end) || end < start)
    throw createError({ statusCode: 400, statusMessage: 'start + end required as ISO YYYY-MM-DD; end must be >= start' })

  const identity = await requireIdentity(event)
  const site = await requireSite(event, identity, siteIdParam)

  setHeader(event, 'Cache-Control', 'private, max-age=30')

  if (identity.attrs?.tier !== 'pro') {
    const accessToken = await resolveGscApiAccessToken(event, identity)
    if (!accessToken)
      throw createError({ statusCode: 502, statusMessage: 'no GSC access token available' })
    const client = googleSearchConsole({ accessToken })
    const rows = await fetchGscTopN({
      client,
      siteUrl: site.siteUrl,
      dimension: searchAppearanceDim,
      range: { start, end },
      sliceTop: 200,
    })
    return {
      rows: rows.map(r => ({
        searchAppearance: r.key,
        clicks: r.clicks,
        impressions: r.impressions,
        sum_position: r.sum_position,
      })),
      range: { start, end },
      generatedAt: new Date().toISOString(),
      source: 'gsc-api',
    }
  }

  const env = useAnalyticsEnv(event)
  const engine = getAnalyticsEngine(env, requireDb(event))
  if (!engine)
    throw createError({ statusCode: 500, statusMessage: 'Analytics engine unavailable' })
  const result = await engine.runSQL({
    ctx: { userId: identity.userId, siteId: site.storageId },
    table: 'search_appearance',
    fileSets: { FILES: { table: 'search_appearance' } },
    sql: `
      SELECT
        searchAppearance,
        SUM(clicks)::BIGINT AS clicks,
        SUM(impressions)::BIGINT AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date BETWEEN '${start}' AND '${end}'
      GROUP BY searchAppearance
      ORDER BY clicks DESC
      LIMIT 200
    `,
  })
  const rows: SearchAppearanceRow[] = result.rows.map((r) => {
    const row = r as Record<string, unknown>
    return {
      searchAppearance: String(row.searchAppearance ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      sum_position: Number(row.sum_position ?? 0),
    }
  })
  return { rows, range: { start, end }, generatedAt: new Date().toISOString(), source: 'engine' }
})
