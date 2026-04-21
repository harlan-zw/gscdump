import { describe, expect, it } from 'vitest'

import {
  cosineNormalized,
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
})
