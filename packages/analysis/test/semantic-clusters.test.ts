import { describe, expect, it } from 'vitest'
import { clusterQueryEmbeddings } from '../src/query/semantic-clusters'

describe('clusterQueryEmbeddings (UPGMA)', () => {
  it('groups cross-lexical synonyms above threshold and stamps ADR-0027 metadata', () => {
    const inputs = [
      { query: 'nyfw', canonical: 'nyfw', impressions: 800, clicks: 40, position: 3, vector: [0.99, 0.14, 0, 0] },
      { query: 'new york fashion week', canonical: 'fashion new week york', impressions: 1200, clicks: 80, position: 2, vector: [0.98, 0.2, 0, 0] },
      { query: 'luxury hotel manhattan', canonical: 'hotel luxury manhattan', impressions: 500, clicks: 20, position: 4, vector: [0, 0, 1, 0] },
    ]
    const out = clusterQueryEmbeddings(inputs, { threshold: 0.86, model: '@cf/baai/bge-m3' })

    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({
      label: 'new york fashion week',
      leadCanonical: 'fashion new week york',
      keywordCount: 2,
      canonicalCount: 2,
      totalImpressions: 2000,
      totalClicks: 120,
    })
    expect(out.results[0]!.meanCentroidSimilarity).toBeGreaterThan(0.99)
    expect(out.results[0]!.minPairwiseSimilarity).toBeGreaterThan(0.99)
    expect(out.meta).toMatchObject({
      algorithm: 'upgma',
      model: '@cf/baai/bge-m3',
      threshold: 0.86,
      totalClusters: 1,
      clusteredQueries: 2,
      unclusteredQueries: 1,
    })
  })

  it('blocks merges across differing version/year, polarity, and directional conversions even with identical vectors', () => {
    const sameVec = [1, 0, 0, 0]
    const inputs = [
      { query: 'nuxt 3 seo', canonical: '3 nuxt seo', impressions: 500, clicks: 20, position: 2, vector: sameVec },
      { query: 'nuxt 4 seo', canonical: '4 nuxt seo', impressions: 500, clicks: 20, position: 2, vector: sameVec },
      { query: 'robots index', canonical: 'index robot', impressions: 300, clicks: 10, position: 3, vector: sameVec },
      { query: 'robots noindex', canonical: 'noindex robot', impressions: 300, clicks: 10, position: 3, vector: sameVec },
      { query: 'png to jpg', canonical: 'png to jpg', impressions: 200, clicks: 8, position: 4, vector: sameVec },
      { query: 'jpg to png', canonical: 'jpg to png', impressions: 200, clicks: 8, position: 4, vector: sameVec },
    ]
    const out = clusterQueryEmbeddings(inputs, { threshold: 0.86 })
    expect(out.results).toEqual([])
    expect(out.meta.unclusteredQueries).toBe(6)
  })

  it('is 100% invariant to input row order (deterministic cluster IDs and membership)', () => {
    const forward = [
      { query: 'a1', canonical: 'a1', impressions: 100, clicks: 5, position: 2, vector: [1, 0, 0] },
      { query: 'a2', canonical: 'a2', impressions: 90, clicks: 4, position: 3, vector: [0.96, 0.28, 0] },
      { query: 'b1', canonical: 'b1', impressions: 80, clicks: 3, position: 4, vector: [0, 1, 0] },
      { query: 'b2', canonical: 'b2', impressions: 70, clicks: 2, position: 5, vector: [0.28, 0.96, 0] },
    ]
    // Use non-numeric labels so all four share one guardrail bucket.
    const clean = forward.map((row, idx) => ({
      ...row,
      query: ['alpha one', 'alpha two', 'beta one', 'beta two'][idx]!,
      canonical: ['alpha one', 'alpha two', 'beta one', 'beta two'][idx]!,
    }))
    const reversed = [...clean].reverse()

    const r1 = clusterQueryEmbeddings(clean, { threshold: 0.86, model: 'test-model' })
    const r2 = clusterQueryEmbeddings(reversed, { threshold: 0.86, model: 'test-model' })
    expect(r1).toEqual(r2)
    expect(r1.results).toHaveLength(2)
  })

  it('prevents single-linkage chaining via average linkage (UPGMA)', () => {
    // A·B = 0.90, B·C = 0.90, A·C = 0.62 -> after {A,B} merges, UPGMA({A,B}, C) = (0.90+0.62)/2 = 0.76 < 0.86.
    const inputs = [
      { query: 'alpha', canonical: 'alpha', impressions: 100, clicks: 5, position: 2, vector: [1, 0] },
      { query: 'beta', canonical: 'beta', impressions: 90, clicks: 4, position: 3, vector: [0.9, Math.sqrt(1 - 0.81)] },
      { query: 'gamma', canonical: 'gamma', impressions: 80, clicks: 3, position: 4, vector: [0.62, Math.sqrt(1 - 0.62 * 0.62)] },
    ]
    const out = clusterQueryEmbeddings(inputs, { threshold: 0.86 })
    expect(out.results).toHaveLength(1)
    expect(out.results[0]!.keywordCount).toBe(2)
    expect(out.meta.unclusteredQueries).toBe(1)
  })
})
