// Server fallback for any analyzer. Returns the same `{ results, meta }`
// envelope the browser-direct path produces, so the client can render the
// response identically whether the feature flag is on or off.
//
// Perf: after the first request the Node DuckDB process is warm and the
// manifest is cached. Expect ~50-200 ms for typical insights on 1M rows.

import type { AnalysisParams } from '@gscdump/analysis'
import { defaultAnalyzerRegistry, runAnalyzerWithEngine } from '@gscdump/analysis'
import { useAnalysisEngine } from '../../utils/analysis-engine'

const VALID = new Set([
  'bayesian-ctr',
  'bipartite-pagerank',
  'brand',
  'cannibalization',
  'change-point',
  'clustering',
  'concentration',
  'content-velocity',
  'ctr-anomaly',
  'ctr-curve',
  'dark-traffic',
  'decay',
  'device-gap',
  'intent-atlas',
  'keyword-breadth',
  'long-tail',
  'movers',
  'opportunity',
  'position-distribution',
  'position-volatility',
  'query-migration',
  'seasonality',
  'stl-decompose',
  'striking-distance',
  'survival',
  'trends',
  'zero-click',
])

export default defineEventHandler(async (event) => {
  const analyzer = getRouterParam(event, 'analyzer')
  if (!analyzer || !VALID.has(analyzer))
    throw createError({ statusCode: 400, statusMessage: `unknown analyzer "${analyzer}"` })

  const query = getQuery(event)
  const params = {
    type: analyzer,
    // Forward per-analyzer params verbatim; analyzers validate their own shape.
    ...query,
    // Ensure numeric fields are numbers where callers pass strings.
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
  } as unknown as AnalysisParams

  const origin = getRequestURL(event).origin
  const t0 = performance.now()
  const { engine, ctx } = await useAnalysisEngine(origin)
  const setupMs = performance.now() - t0

  const t1 = performance.now()
  const result = await runAnalyzerWithEngine({ engine }, ctx, params, defaultAnalyzerRegistry)
  const queryMs = performance.now() - t1

  return {
    ...result,
    meta: {
      ...result.meta,
      source: 'server',
      timings: { setupMs, queryMs, totalMs: setupMs + queryMs },
    },
  }
})
