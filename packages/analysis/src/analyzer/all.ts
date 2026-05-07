/**
 * Central list of every in-tree `defineAnalyzer` instance. Single source of
 * truth for `ROW_ANALYZERS`, `SQL_ANALYZERS`, and `defaultAnalyzerRegistry`.
 *
 * Add new analyzers here once; SQL/row arrays and the default registry derive
 * automatically — no risk of forgetting to wire up a new analyzer.
 */

import type { DefinedAnalyzer } from '@gscdump/engine/analyzer'

import { bayesianCtrAnalyzer } from '../analyzers/bayesian-ctr'
import { bipartitePagerankAnalyzer } from '../analyzers/bipartite-pagerank'
import { brandAnalyzer } from '../analyzers/brand'
import { cannibalizationAnalyzer } from '../analyzers/cannibalization'
import { changePointAnalyzer } from '../analyzers/change-point'
import { clusteringAnalyzer } from '../analyzers/clustering'
import { concentrationAnalyzer } from '../analyzers/concentration'
import { contentVelocityAnalyzer } from '../analyzers/content-velocity'
import { ctrAnomalyAnalyzer } from '../analyzers/ctr-anomaly'
import { ctrCurveAnalyzer } from '../analyzers/ctr-curve'
import { darkTrafficAnalyzer } from '../analyzers/dark-traffic'
import { dataDetailAnalyzer } from '../analyzers/data-detail'
import { dataQueryAnalyzer } from '../analyzers/data-query'
import { decayAnalyzer } from '../analyzers/decay'
import { deviceGapAnalyzer } from '../analyzers/device-gap'
import { intentAtlasAnalyzer } from '../analyzers/intent-atlas'
import { keywordBreadthAnalyzer } from '../analyzers/keyword-breadth'
import { longTailAnalyzer } from '../analyzers/long-tail'
import { moversAnalyzer } from '../analyzers/movers'
import { opportunityAnalyzer } from '../analyzers/opportunity'
import { positionDistributionAnalyzer } from '../analyzers/position-distribution'
import { positionVolatilityAnalyzer } from '../analyzers/position-volatility'
import { queryMigrationAnalyzer } from '../analyzers/query-migration'
import { seasonalityAnalyzer } from '../analyzers/seasonality'
import { stlDecomposeAnalyzer } from '../analyzers/stl-decompose'
import { strikingDistanceAnalyzer } from '../analyzers/striking-distance'
import { survivalAnalyzer } from '../analyzers/survival'
import { trendsAnalyzer } from '../analyzers/trends'
import { zeroClickAnalyzer } from '../analyzers/zero-click'

export const ALL_ANALYZERS: readonly DefinedAnalyzer[] = [
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
]
