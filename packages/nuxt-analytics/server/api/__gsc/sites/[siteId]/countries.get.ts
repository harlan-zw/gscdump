// GET /api/__gsc/sites/[siteId]/countries?start=&end=
//
// Per-country breakdown for a range. Tier branching:
//   - Free  → live GSC API via the host-registered access-token provider.
//   - Pro   → engine SQL over R2 parquet (`countries` table).
//
// Lives in the layer so the GSC-API↔engine dispatch is a single source of
// truth across hosts. Host wires the seams (auth/site/db/token) via plugins.

import type { CountriesResponse, CountryRow } from '@gscdump/nuxt-analytics/types'
import { getAnalyticsEngine } from '@gscdump/nuxt-analytics/internal/engine'
import { googleSearchConsole } from 'gscdump'
import { country as countryDim } from 'gscdump/query'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default defineEventHandler(async (event): Promise<CountriesResponse> => {
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
      dimension: countryDim,
      range: { start, end },
      sliceTop: 200,
    })
    return {
      rows: rows.map(r => ({
        country: r.key,
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
    table: 'countries',
    fileSets: { FILES: { table: 'countries' } },
    sql: `
      SELECT
        country,
        SUM(clicks)::BIGINT AS clicks,
        SUM(impressions)::BIGINT AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date BETWEEN '${start}' AND '${end}'
      GROUP BY country
      ORDER BY clicks DESC
      LIMIT 200
    `,
  })
  const rows: CountryRow[] = result.rows.map((r) => {
    const row = r as Record<string, unknown>
    return {
      country: String(row.country ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      sum_position: Number(row.sum_position ?? 0),
    }
  })
  return { rows, range: { start, end }, generatedAt: new Date().toISOString(), source: 'engine' }
})
