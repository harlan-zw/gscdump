/**
 * `bayesian-ctr` — Empirical-Bayes CTR shrinkage. SQL-only colocation.
 *
 * Migrated from `engine-duckdb-node/src/analyzers/bayesian-ctr.ts`.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'

function num(v: unknown): number {
  if (typeof v === 'number')
    return v
  if (typeof v === 'bigint')
    return Number(v)
  if (v == null)
    return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

export interface BayesianCtrResult {
  keyword: string
  page: string
  clicks: number
  impressions: number
  observedCtr: number
  position: number
  bucket: number
  priorAlpha: number
  priorBeta: number
  bucketPriorMean: number
  posteriorMean: number
  posteriorSd: number
  ciLow: number
  ciHigh: number
  shrinkageDelta: number
  expectedClicksDelta: number
  significance: number
  classification: 'overperforming' | 'underperforming' | 'expected'
}

export const bayesianCtrAnalyzer = defineAnalyzer<AnalysisParams, Row, BayesianCtrResult[]>({
  id: 'bayesian-ctr',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 50
    const limit = params.limit ?? 300
    const priorMinEntities = 5

    const sql = `
    WITH entity AS (
      SELECT
        query,
        url,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.ctr} AS observed_ctr,
        ${METRIC_EXPR.position} AS position,
        CAST(ROUND(LEAST(${METRIC_EXPR.position}, 30)) AS INTEGER) AS bucket
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
        AND ${METRIC_EXPR.position} <= 30
    ),
    bucket_mu AS (
      SELECT
        bucket,
        COUNT(*) AS n_entities,
        SUM(observed_ctr * impressions) / NULLIF(SUM(impressions), 0) AS mu,
        SUM(impressions) AS total_impressions
      FROM entity
      GROUP BY bucket
    ),
    bucket_var AS (
      SELECT
        e.bucket,
        GREATEST(
          SUM(e.impressions * POWER(e.observed_ctr - b.mu, 2))
            / NULLIF(SUM(e.impressions), 0),
          1e-9
        ) AS v
      FROM entity e
      JOIN bucket_mu b USING (bucket)
      GROUP BY e.bucket
    ),
    priors AS (
      SELECT
        m.bucket,
        m.n_entities,
        m.mu,
        v.v,
        CASE
          WHEN m.n_entities >= ${Number(priorMinEntities)}
            AND v.v > 0
            AND m.mu > 0 AND m.mu < 1
            AND (m.mu * (1.0 - m.mu) / v.v - 1.0) > 0
          THEN GREATEST(0.5, m.mu * (m.mu * (1.0 - m.mu) / v.v - 1.0))
          ELSE 2.0
        END AS alpha,
        CASE
          WHEN m.n_entities >= ${Number(priorMinEntities)}
            AND v.v > 0
            AND m.mu > 0 AND m.mu < 1
            AND (m.mu * (1.0 - m.mu) / v.v - 1.0) > 0
          THEN GREATEST(0.5, (1.0 - m.mu) * (m.mu * (1.0 - m.mu) / v.v - 1.0))
          ELSE 48.0
        END AS beta
      FROM bucket_mu m
      JOIN bucket_var v USING (bucket)
    ),
    posterior AS (
      SELECT
        e.query,
        e.url,
        e.clicks,
        e.impressions,
        e.observed_ctr,
        e.position,
        e.bucket,
        p.alpha AS prior_alpha,
        p.beta AS prior_beta,
        p.mu AS bucket_prior_mean,
        p.alpha + e.clicks AS alpha_post,
        p.beta + (e.impressions - e.clicks) AS beta_post
      FROM entity e
      JOIN priors p USING (bucket)
    ),
    scored AS (
      SELECT *,
        alpha_post / (alpha_post + beta_post) AS posterior_mean,
        SQRT((alpha_post * beta_post)
          / (POWER(alpha_post + beta_post, 2) * (alpha_post + beta_post + 1))) AS posterior_sd
      FROM posterior
    )
    SELECT
      query AS keyword,
      url AS page,
      clicks,
      impressions,
      observed_ctr AS observedCtr,
      position,
      bucket,
      prior_alpha AS priorAlpha,
      prior_beta AS priorBeta,
      bucket_prior_mean AS bucketPriorMean,
      posterior_mean AS posteriorMean,
      posterior_sd AS posteriorSd,
      GREATEST(0.0, posterior_mean - 1.96 * posterior_sd) AS ciLow,
      LEAST(1.0, posterior_mean + 1.96 * posterior_sd) AS ciHigh,
      posterior_mean - observed_ctr AS shrinkageDelta,
      (posterior_mean - observed_ctr) * impressions AS expectedClicksDelta,
      ABS(observed_ctr - posterior_mean) / NULLIF(posterior_sd, 0) AS significance,
      CASE
        WHEN observed_ctr > LEAST(1.0, posterior_mean + 1.96 * posterior_sd) THEN 'overperforming'
        WHEN observed_ctr < GREATEST(0.0, posterior_mean - 1.96 * posterior_sd) THEN 'underperforming'
        ELSE 'expected'
      END AS classification
    FROM scored
    ORDER BY significance DESC NULLS LAST
    LIMIT ${Number(limit)}
  `

    return {
      sql,
      params: [startDate, endDate, minImpressions],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const minImpressions = params.minImpressions ?? 50
    const results: BayesianCtrResult[] = arr.map(r => ({
      keyword: str(r.keyword),
      page: str(r.page),
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      observedCtr: num(r.observedCtr),
      position: num(r.position),
      bucket: num(r.bucket),
      priorAlpha: num(r.priorAlpha),
      priorBeta: num(r.priorBeta),
      bucketPriorMean: num(r.bucketPriorMean),
      posteriorMean: num(r.posteriorMean),
      posteriorSd: num(r.posteriorSd),
      ciLow: num(r.ciLow),
      ciHigh: num(r.ciHigh),
      shrinkageDelta: num(r.shrinkageDelta),
      expectedClicksDelta: num(r.expectedClicksDelta),
      significance: num(r.significance),
      classification: str(r.classification) as 'overperforming' | 'underperforming' | 'expected',
    }))
    const under = results.filter(r => r.classification === 'underperforming').length
    const over = results.filter(r => r.classification === 'overperforming').length
    return {
      results,
      meta: {
        total: results.length,
        underperforming: under,
        overperforming: over,
        expected: results.length - under - over,
        minImpressions,
      },
    }
  },
})
