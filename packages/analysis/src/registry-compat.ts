/**
 * Compat shim: a direct tool-id → legacy `AnalyzerSpec` lookup for
 * `analyzeInBrowser`, which still needs the spec's `shape` closure after
 * rewriting `{{FILES}}` placeholders to attached table refs.
 *
 * Disappears in step 7 when the browser path moves to the unified dispatcher.
 */

import type { Analyzer } from '@gscdump/engine/analyzer'
import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams, AnalyzerSpec } from './analyzer-runtime'
import {
  bayesianCtrAnalyzer,
  bipartitePagerankAnalyzer,
  brandAnalyzer,
  cannibalizationAnalyzer,
  changePointAnalyzer,
  clusteringAnalyzer,
  concentrationAnalyzer,
  contentVelocityAnalyzer,
  ctrAnomalyAnalyzer,
  ctrCurveAnalyzer,
  darkTrafficAnalyzer,
  dataDetailAnalyzer,
  dataQueryAnalyzer,
  decayAnalyzer,
  deviceGapAnalyzer,
  intentAtlasAnalyzer,
  keywordBreadthAnalyzer,
  longTailAnalyzer,
  moversAnalyzer,
  opportunityAnalyzer,
  positionDistributionAnalyzer,
  positionVolatilityAnalyzer,
  queryMigrationAnalyzer,
  seasonalityAnalyzer,
  stlDecomposeAnalyzer,
  strikingDistanceAnalyzer,
  survivalAnalyzer,
  trendsAnalyzer,
  zeroClickAnalyzer,
} from './analyzer'
import { AnalyzerUnsupportedError } from './analyzer-runtime'

const ANALYZERS: Record<string, Analyzer> = {
  'bayesian-ctr': bayesianCtrAnalyzer.sql!,
  'bipartite-pagerank': bipartitePagerankAnalyzer.sql!,
  'brand': brandAnalyzer.sql!,
  'cannibalization': cannibalizationAnalyzer.sql!,
  'change-point': changePointAnalyzer.sql!,
  'clustering': clusteringAnalyzer.sql!,
  'concentration': concentrationAnalyzer.sql!,
  'content-velocity': contentVelocityAnalyzer.sql!,
  'ctr-anomaly': ctrAnomalyAnalyzer.sql!,
  'ctr-curve': ctrCurveAnalyzer.sql!,
  'dark-traffic': darkTrafficAnalyzer.sql!,
  'data-detail': dataDetailAnalyzer.sql!,
  'data-query': dataQueryAnalyzer.sql!,
  'decay': decayAnalyzer.sql!,
  'device-gap': deviceGapAnalyzer.sql!,
  'intent-atlas': intentAtlasAnalyzer.sql!,
  'keyword-breadth': keywordBreadthAnalyzer.sql!,
  'long-tail': longTailAnalyzer.sql!,
  'movers': moversAnalyzer.sql!,
  'opportunity': opportunityAnalyzer.sql!,
  'position-distribution': positionDistributionAnalyzer.sql!,
  'position-volatility': positionVolatilityAnalyzer.sql!,
  'query-migration': queryMigrationAnalyzer.sql!,
  'seasonality': seasonalityAnalyzer.sql!,
  'stl-decompose': stlDecomposeAnalyzer.sql!,
  'striking-distance': strikingDistanceAnalyzer.sql!,
  'survival': survivalAnalyzer.sql!,
  'trends': trendsAnalyzer.sql!,
  'zero-click': zeroClickAnalyzer.sql!,
}

export function buildSqlSpec(params: AnalysisParams): AnalyzerSpec {
  const a = ANALYZERS[params.type]
  if (!a)
    throw new AnalyzerUnsupportedError(params.type)
  return unifiedToSpec(a, params)
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
