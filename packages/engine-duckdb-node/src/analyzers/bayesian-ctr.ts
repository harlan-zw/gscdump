/**
 * bayesian-ctr
 *
 * Empirical-Bayes CTR shrinkage. For each position bucket (1..30) we fit a
 * Beta(α, β) prior from the impression-weighted mean/variance of per-entity
 * CTR via method-of-moments, then combine with each entity's observed clicks
 * and impressions to produce a posterior mean + 95% normal-approx CI. Entities
 * whose observed CTR lies outside their CI are flagged overperforming or
 * underperforming; the rest are "expected". Ranked by posterior-SD-normalized
 * significance so small samples don't dominate.
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, period, str } from '../shared'

export function buildBayesianCtr(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 50
  const limit = params.limit ?? 300
  const priorMinEntities = 5

  const sql = `
    WITH entity AS (
      SELECT
        query,
        url,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS observed_ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position,
        CAST(ROUND(LEAST(SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1, 30)) AS INTEGER) AS bucket
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
        AND SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 <= 30
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
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const results = rows.map(r => ({
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
  }
}
