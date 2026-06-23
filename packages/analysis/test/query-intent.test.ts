import { describe, expect, it } from 'vitest'
import { classifyQueryIntent, decodeIntent, encodeIntent, INTENT_CLASSIFIER_VERSION, SEARCH_INTENT_CODE } from '../src/query/intent'

describe('classifyQueryIntent', () => {
  it('informational: question words + info nouns', () => {
    expect(classifyQueryIntent('what is a canonical url').intent).toBe('informational')
    expect(classifyQueryIntent('sitemap tutorial').intent).toBe('informational')
    expect(classifyQueryIntent('nuxt seo guide').intent).toBe('informational')
  })

  it('how-to is flagged and informational', () => {
    const r = classifyQueryIntent('how to validate a sitemap')
    expect(r.howTo).toBe(true)
    expect(r.intent).toBe('informational')
  })

  it('commercial: comparison / investigation cues', () => {
    expect(classifyQueryIntent('nuxt vs next').intent).toBe('commercial')
    expect(classifyQueryIntent('best seo tools').intent).toBe('commercial')
    expect(classifyQueryIntent('cloudflare alternatives').intent).toBe('commercial')
  })

  it('transactional: buy / price / free / download cues (read from raw, not canonical)', () => {
    expect(classifyQueryIntent('buy nuxt course').intent).toBe('transactional')
    expect(classifyQueryIntent('ahrefs pricing').intent).toBe('transactional')
    // `free` is stripped by normalizeQuery but is a real transactional signal here.
    expect(classifyQueryIntent('free sitemap checker').intent).toBe('transactional')
    expect(classifyQueryIntent('domains for sale').intent).toBe('transactional')
  })

  it('priority: transactional > commercial > informational', () => {
    // "best … price" carries both commercial + transactional → transactional wins.
    expect(classifyQueryIntent('best seo tool price').intent).toBe('transactional')
    // "how to buy" → transactional outranks the informational how-to.
    const r = classifyQueryIntent('how to buy a domain')
    expect(r.intent).toBe('transactional')
    expect(r.howTo).toBe(true)
  })

  it('unknown when no cues match', () => {
    expect(classifyQueryIntent('nuxt seo').intent).toBe('unknown')
    expect(classifyQueryIntent('sitemap').intent).toBe('unknown')
  })

  it('folds case/diacritics/separators like the normalizer', () => {
    expect(classifyQueryIntent('CÓMO vs Next')).toEqual(classifyQueryIntent('como vs next'))
    expect(classifyQueryIntent('nuxt-vs-next').intent).toBe('commercial')
  })

  it('is deterministic and exposes a version', () => {
    expect(classifyQueryIntent('best price')).toEqual(classifyQueryIntent('best price'))
    expect(INTENT_CLASSIFIER_VERSION).toBe(1)
  })

  it('encodes to a cheap int and round-trips', () => {
    for (const q of ['nuxt seo', 'what is seo', 'nuxt vs next', 'buy domain', 'how to buy a domain']) {
      const c = classifyQueryIntent(q)
      const code = encodeIntent(c)
      expect(code).toBeGreaterThanOrEqual(0)
      expect(code).toBeLessThanOrEqual(0b111)
      expect(decodeIntent(code)).toEqual({ intent: c.intent, howTo: c.howTo })
    }
    // packing: intent in low 2 bits, howTo in bit 2.
    expect(encodeIntent({ intent: 'unknown', howTo: false })).toBe(0)
    expect(encodeIntent({ intent: 'transactional', howTo: false })).toBe(SEARCH_INTENT_CODE.transactional)
    expect(encodeIntent({ intent: 'informational', howTo: true })).toBe(SEARCH_INTENT_CODE.informational | 0b100)
  })
})
