/**
 * DuckDB SQL analyzer collection. Pure array export — no side effects.
 * Pass to `createAnalyzerRegistry({ sql: SQL_ANALYZERS })` when composing
 * a registry that serves SQL-capable sources.
 */

import type { Analyzer } from '@gscdump/analysis/analyzer'

import { strikingDistanceAnalyzer } from '@gscdump/analysis/analyzer'
import { adaptSqlAnalyzer } from './adapt-sql'
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

export const SQL_ANALYZERS: readonly Analyzer[] = [
  adaptSqlAnalyzer({ id: 'bayesian-ctr', builder: buildBayesianCtr }),
  adaptSqlAnalyzer({ id: 'bipartite-pagerank', builder: buildBipartitePageRank }),
  adaptSqlAnalyzer({ id: 'brand', builder: buildBrand }),
  adaptSqlAnalyzer({ id: 'cannibalization', builder: buildCannibalization }),
  adaptSqlAnalyzer({ id: 'change-point', builder: buildChangePoint }),
  adaptSqlAnalyzer({ id: 'clustering', builder: buildClustering }),
  adaptSqlAnalyzer({ id: 'concentration', builder: buildConcentration }),
  adaptSqlAnalyzer({ id: 'content-velocity', builder: buildContentVelocity }),
  adaptSqlAnalyzer({ id: 'ctr-anomaly', builder: buildCtrAnomaly }),
  adaptSqlAnalyzer({ id: 'ctr-curve', builder: buildCtrCurve }),
  adaptSqlAnalyzer({ id: 'dark-traffic', builder: buildDarkTraffic }),
  adaptSqlAnalyzer({ id: 'data-detail', builder: buildDataDetail }),
  adaptSqlAnalyzer({ id: 'data-query', builder: buildDataQuery }),
  adaptSqlAnalyzer({ id: 'decay', builder: buildDecay }),
  adaptSqlAnalyzer({ id: 'device-gap', builder: buildDeviceGap }),
  adaptSqlAnalyzer({ id: 'intent-atlas', builder: buildIntentAtlas }),
  adaptSqlAnalyzer({ id: 'keyword-breadth', builder: buildKeywordBreadth }),
  adaptSqlAnalyzer({ id: 'long-tail', builder: buildLongTail }),
  adaptSqlAnalyzer({ id: 'movers', builder: buildMovers }),
  adaptSqlAnalyzer({ id: 'opportunity', builder: buildOpportunity }),
  adaptSqlAnalyzer({ id: 'position-distribution', builder: buildPositionDistribution }),
  adaptSqlAnalyzer({ id: 'position-volatility', builder: buildPositionVolatility }),
  adaptSqlAnalyzer({ id: 'query-migration', builder: buildQueryMigration }),
  adaptSqlAnalyzer({ id: 'seasonality', builder: buildSeasonality }),
  adaptSqlAnalyzer({ id: 'stl-decompose', builder: buildStlDecompose }),
  strikingDistanceAnalyzer.sql!,
  adaptSqlAnalyzer({ id: 'survival', builder: buildSurvival }),
  adaptSqlAnalyzer({ id: 'trends', builder: buildTrends }),
  adaptSqlAnalyzer({ id: 'zero-click', builder: buildZeroClick }),
]
