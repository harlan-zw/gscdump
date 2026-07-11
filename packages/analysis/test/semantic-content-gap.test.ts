import type { AnalysisQuerySource } from '@gscdump/engine/source'
import type { ContentGapEmbeddingRuntime } from '../src/semantic'
import { describe, expect, it } from 'vitest'

import {
  cosineNormalized,
  createContentGapAnalyzer,
  deriveUrlText,
  normalizeUrl,
  rankContentGaps,
} from '../src/semantic'

describe('semantic/content-gap', () => {
  it('normalizes URLs consistently', () => {
    expect(normalizeUrl('https://example.com/foo/?a=1#bar')).toBe('https://example.com/foo')
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/')
    expect(normalizeUrl('https://example.com/foo')).toBe('https://example.com/foo')
  })

  it('derives readable URL text', () => {
    expect(deriveUrlText('https://www.example.com/pricing/seo-audit/')).toBe('pricing seo audit')
    expect(deriveUrlText('https://www.example.com/')).toBe('example com')
  })

  it('computes cosine similarity for normalized vectors', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0.6, 0.8])
    expect(cosineNormalized(a, b)).toBeCloseTo(0.6, 6)
  })

  it('ranks content gaps by divergence and impact', () => {
    const results = rankContentGaps(
      [
        {
          query: 'pricing',
          impressions: 1000,
          clicks: 20,
          avgPosition: 6,
          currentUrl: 'https://example.com/blog/pricing',
        },
        {
          query: 'contact',
          impressions: 300,
          clicks: 10,
          avgPosition: 3,
          currentUrl: 'https://example.com/contact',
        },
      ],
      [
        'https://example.com/blog/pricing',
        'https://example.com/pricing',
        'https://example.com/contact',
      ],
      [
        new Float32Array([1, 0]),
        new Float32Array([0, 1]),
      ],
      [
        new Float32Array([0.6, 0.8]),
        new Float32Array([1, 0]),
        new Float32Array([0, 1]),
      ],
      0.12,
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      query: 'pricing',
      currentUrl: 'https://example.com/blog/pricing',
      suggestedUrl: 'https://example.com/pricing',
    })
    expect(results[0].divergence).toBeCloseTo(0.4, 5)
    expect(results[0].impact).toBeCloseTo(400, 3)
  })

  it('retains only the top three alternatives in stable similarity order', () => {
    const results = rankContentGaps(
      [{ query: 'target', impressions: 100, clicks: 1, avgPosition: 5, currentUrl: '/current' }],
      ['/current', '/best', '/equal-a', '/equal-b', '/last'],
      [new Float32Array([1, 0])],
      [
        new Float32Array([0.1, 0]),
        new Float32Array([0.9, 0]),
        new Float32Array([0.7, 0]),
        new Float32Array([0.7, 0]),
        new Float32Array([0.2, 0]),
      ],
      0.1,
    )

    expect(results[0]?.suggestedUrl).toBe('/best')
    expect(results[0]?.alternatives.map(item => item.url)).toEqual(['/equal-a', '/equal-b', '/last'])
  })

  it('returns no gaps when there are no URL candidates', () => {
    expect(rankContentGaps(
      [{ query: 'target', impressions: 100, clicks: 1, avgPosition: 5, currentUrl: '/current' }],
      [],
      [new Float32Array([1, 0])],
      [],
      0.1,
    )).toEqual([])
  })

  it('runs through an injected embedding and input seam', async () => {
    const source: AnalysisQuerySource = {
      capabilities: {},
      queryRows: async () => [],
      executeSql: async () => [],
    }
    const embeddings: ContentGapEmbeddingRuntime = {
      modelId: 'test/model',
      queryPrefix: 'query: ',
      selectDevice: async () => 'wasm',
      loadExtractor: async () => async () => ({ data: new Float32Array(), dims: [0, 0] }),
      async embed(_extractor, role, texts, transform, onProgress) {
        onProgress(texts.length, texts.length)
        const vectors = role === 'query'
          ? [new Float32Array([1, 0])]
          : [new Float32Array([0.2, 0]), new Float32Array([0.9, 0])]
        expect(texts.map(transform)).toHaveLength(texts.length)
        return { vectors, hits: 0, misses: texts.length }
      },
    }
    let clock = 0
    const analyzer = createContentGapAnalyzer({
      embeddings,
      now: () => ++clock,
      loadInputs: async () => ({
        queries: [{ query: 'pricing', impressions: 1000, clicks: 20, avgPosition: 6, currentUrl: 'https://example.com/old' }],
        urls: ['https://example.com/old', 'https://example.com/new'],
        sqlMs: 2,
      }),
    })

    const result = await analyzer.analyze(source)

    expect(result.results[0]).toMatchObject({ query: 'pricing', suggestedUrl: 'https://example.com/new' })
    expect(result.meta).toMatchObject({ device: 'wasm', modelId: 'test/model', totalInputs: 3 })
  })
})
