/**
 * Row-based analyzer collection. Pure JS — portable across any
 * `AnalysisQuerySource` that yields rows (live GSC API, in-memory, SQL
 * engines via their row path).
 *
 * Export is a plain array so consumers can compose registries without
 * triggering side effects. Pass to `createAnalyzerRegistry({ rows: ROW_ANALYZERS })`.
 */

import type { Analyzer } from './types'

import { brandAnalyzer } from '../analyzers/brand'
import { cannibalizationAnalyzer } from '../analyzers/cannibalization'
import { clusteringAnalyzer } from '../analyzers/clustering'
import { concentrationAnalyzer } from '../analyzers/concentration'
import { decayAnalyzer } from '../analyzers/decay'
import { moversAnalyzer } from '../analyzers/movers'
import { opportunityAnalyzer } from '../analyzers/opportunity'
import { seasonalityAnalyzer } from '../analyzers/seasonality'
import { strikingDistanceAnalyzer } from '../analyzers/striking-distance'
import { zeroClickAnalyzer } from '../analyzers/zero-click'

export const ROW_ANALYZERS: readonly Analyzer[] = [
  strikingDistanceAnalyzer.rows!,
  opportunityAnalyzer.rows!,
  brandAnalyzer.rows!,
  concentrationAnalyzer.rows!,
  clusteringAnalyzer.rows!,
  seasonalityAnalyzer.rows!,
  moversAnalyzer.rows!,
  decayAnalyzer.rows!,
  cannibalizationAnalyzer.rows!,
  zeroClickAnalyzer.rows!,
]
