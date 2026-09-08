import type { AnalysisParams } from '../src/types'
import { pgResolverAdapter } from '@gscdump/engine/resolver'
import { between, date, gsc, page } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { defaultAnalyzerRegistry } from '../src/default-registry'

// Two shapes: `data-query` rejects date dimension (list/breakdown view);
// `data-detail` requires date dimension (per-entity timeseries). Base uses
// the timeseries shape; tool overrides below swap to the non-date shape for
// data-query.
const SAMPLE_QUERY_TIMESERIES = gsc
  .select(page, date)
  .where(between(date, '2024-02-01', '2024-02-29'))
  .limit(100)
  .getState()

const SAMPLE_COMPARISON_TIMESERIES = gsc
  .select(page, date)
  .where(between(date, '2024-01-01', '2024-01-31'))
  .limit(100)
  .getState()

const SAMPLE_QUERY_LIST = gsc
  .select(page)
  .where(between(date, '2024-02-01', '2024-02-29'))
  .limit(100)
  .getState()

const SAMPLE_COMPARISON_LIST = gsc
  .select(page)
  .where(between(date, '2024-01-01', '2024-01-31'))
  .limit(100)
  .getState()

const PARAM_OVERRIDES: Record<string, Partial<AnalysisParams>> = {
  'data-query': { q: SAMPLE_QUERY_LIST, qc: SAMPLE_COMPARISON_LIST },
}

/**
 * Snapshot every analyzer's `build(params)` output. The plan shape (SQL text,
 * params, file-set references, row-query states) is the contract between
 * analyzers and executors — silent rewrites otherwise sneak in unnoticed.
 *
 * To intentionally update a plan, re-run with `-u` and review the diff.
 */

const BASE_PARAMS: Omit<AnalysisParams, 'type'> = {
  startDate: '2024-02-01',
  endDate: '2024-02-29',
  prevStartDate: '2024-01-01',
  prevEndDate: '2024-01-31',
  limit: 100,
  offset: 0,
  brandTerms: ['acme', 'acme-corp'],
  minImpressions: 10,
  minPosition: 4,
  maxPosition: 20,
  maxCtr: 0.05,
  minPages: 2,
  maxPositionSpread: 5,
  minClusterSize: 3,
  clusterBy: 'both',
  dimension: 'pages',
  metric: 'clicks',
  topN: 10,
  weeks: 12,
  minWeeksWithData: 6,
  changeThreshold: 0.2,
  minPreviousClicks: 10,
  threshold: 0.3,
  days: 90,
  comparisonFilter: 'improving',
  q: SAMPLE_QUERY_TIMESERIES,
  qc: SAMPLE_COMPARISON_TIMESERIES,
}

describe('analyzer plan snapshots', () => {
  const ids = defaultAnalyzerRegistry.listAnalyzerIds()
  for (const id of ids) {
    const variants = defaultAnalyzerRegistry.getAnalyzerVariants(id)!
    const params: AnalysisParams = {
      ...BASE_PARAMS,
      ...PARAM_OVERRIDES[id],
      type: id as AnalysisParams['type'],
    }
    // PageRank uses executed graph fixtures in pagerank.test.ts.
    if (variants.sql && id !== 'bipartite-pagerank') {
      it(`sql plan: ${id}`, () => {
        expect(variants.sql!.build(params, { adapter: pgResolverAdapter })).toMatchSnapshot()
      })
    }
    if (variants.rows) {
      it(`rows plan: ${id}`, () => {
        expect(variants.rows!.build(params, { adapter: pgResolverAdapter })).toMatchSnapshot()
      })
    }
  }
})
