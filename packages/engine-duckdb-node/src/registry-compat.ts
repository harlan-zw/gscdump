/**
 * Compat shim: a direct tool-id → legacy `AnalyzerSpec` lookup for
 * `analyzeInBrowser`, which still needs the spec's `shape` closure after
 * rewriting `{{FILES}}` placeholders to attached table refs.
 *
 * Disappears in step 7 when the browser path moves to the unified dispatcher.
 */

import type { Analyzer } from '@gscdump/analysis/analyzer'
import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams, AnalyzerSpec } from './shared'
import { strikingDistanceAnalyzer } from '@gscdump/analysis/analyzer'
import { buildBayesianCtr } from './analyzers/bayesian-ctr'
import { buildBipartitePageRank } from './analyzers/bipartite-pagerank'
import { buildBrand } from './analyzers/brand'
import { buildCannibalization } from './analyzers/cannibalization'
import { buildChangePoint } from './analyzers/change-point'
import { buildClustering } from './analyzers/clustering'
import { buildConcentration } from './analyzers/concentration'
import { buildContentVelocity } from './analyzers/content-velocity'
import { buildCtrAnomaly } from './analyzers/ctr-anomaly'
import { buildCtrCurve } from './analyzers/ctr-curve'
import { buildDarkTraffic } from './analyzers/dark-traffic'
import { buildDataDetail } from './analyzers/data-detail'
import { buildDataQuery } from './analyzers/data-query'
import { buildDecay } from './analyzers/decay'
import { buildDeviceGap } from './analyzers/device-gap'
import { buildIntentAtlas } from './analyzers/intent-atlas'
import { buildKeywordBreadth } from './analyzers/keyword-breadth'
import { buildLongTail } from './analyzers/long-tail'
import { buildMovers } from './analyzers/movers'
import { buildOpportunity } from './analyzers/opportunity'
import { buildPositionDistribution } from './analyzers/position-distribution'
import { buildPositionVolatility } from './analyzers/position-volatility'
import { buildQueryMigration } from './analyzers/query-migration'
import { buildSeasonality } from './analyzers/seasonality'
import { buildStlDecompose } from './analyzers/stl-decompose'
import { buildSurvival } from './analyzers/survival'
import { buildTrends } from './analyzers/trends'
import { buildZeroClick } from './analyzers/zero-click'
import { AnalyzerUnsupportedError } from './shared'

const BUILDERS: Record<string, (p: AnalysisParams) => AnalyzerSpec> = {
  'bayesian-ctr': buildBayesianCtr,
  'bipartite-pagerank': buildBipartitePageRank,
  'brand': buildBrand,
  'cannibalization': buildCannibalization,
  'change-point': buildChangePoint,
  'clustering': buildClustering,
  'concentration': buildConcentration,
  'content-velocity': buildContentVelocity,
  'ctr-anomaly': buildCtrAnomaly,
  'ctr-curve': buildCtrCurve,
  'dark-traffic': buildDarkTraffic,
  'data-detail': buildDataDetail,
  'data-query': buildDataQuery,
  'decay': buildDecay,
  'device-gap': buildDeviceGap,
  'intent-atlas': buildIntentAtlas,
  'keyword-breadth': buildKeywordBreadth,
  'long-tail': buildLongTail,
  'movers': buildMovers,
  'opportunity': buildOpportunity,
  'position-distribution': buildPositionDistribution,
  'position-volatility': buildPositionVolatility,
  'query-migration': buildQueryMigration,
  'seasonality': buildSeasonality,
  'stl-decompose': buildStlDecompose,
  'striking-distance': (params: AnalysisParams) => unifiedToSpec(strikingDistanceAnalyzer.sql!, params),
  'survival': buildSurvival,
  'trends': buildTrends,
  'zero-click': buildZeroClick,
}

export function buildSqlSpec(params: AnalysisParams): AnalyzerSpec {
  const builder = BUILDERS[params.type]
  if (!builder)
    throw new AnalyzerUnsupportedError(params.type)
  return builder(params)
}

/**
 * Project a unified `Analyzer` (from `defineAnalyzer`) into the legacy
 * `AnalyzerSpec` shape `analyzeInBrowser` still consumes. Disappears when
 * the browser path moves to the unified dispatcher.
 */
function unifiedToSpec(a: Analyzer, params: AnalysisParams): AnalyzerSpec {
  const plan = a.build(params)
  if (plan.kind !== 'sql')
    throw new Error(`analyzer "${a.id}" has no SQL plan`)
  return {
    sql: plan.sql,
    params: plan.params,
    current: plan.current,
    previous: plan.previous,
    extraFiles: plan.extraFiles,
    extraQueries: plan.extraQueries,
    requiresAttachedTables: plan.requiresAttachedTables,
    shape: (rows: Row[], p: AnalysisParams, extras?: Record<string, Row[]>) => {
      const { results, meta } = a.reduce(rows, { params: p, extras })
      return {
        results: results as Row[],
        meta: meta ?? {},
      }
    },
  }
}
