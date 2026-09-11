import { describe, expect, it } from 'vitest'
import { normalizeQuery, NORMALIZER_VERSION } from '../src/query/normalize'

describe('normalizeQuery', () => {
  it('lowercases and sorts tokens', () => {
    expect(normalizeQuery('Nuxt SEO')).toBe('nuxt seo')
    expect(normalizeQuery('SEO Nuxt')).toBe('nuxt seo')
  })

  it('strips separators (- / . @ #)', () => {
    expect(normalizeQuery('nuxt-seo')).toBe('nuxt seo')
    expect(normalizeQuery('nuxt/seo')).toBe('nuxt seo')
    expect(normalizeQuery('@nuxtjs/seo')).toBe('nuxtjs seo')
    expect(normalizeQuery('nuxt.js')).toBe('js nuxt')
    expect(normalizeQuery('schema.org')).toBe('org schema')
  })

  it('drops quotes and treats sentence punctuation as separators', () => {
    expect(normalizeQuery('"keyword cannibalization checker')).toBe(normalizeQuery('keyword cannibalization checker'))
    expect(normalizeQuery('what is nuxt seo?')).toBe(normalizeQuery('what is nuxt seo'))
    expect(normalizeQuery('nuxt seo (module)')).toBe(normalizeQuery('nuxt seo module'))
    expect(normalizeQuery('don\'t index')).toBe(normalizeQuery('dont index'))
  })

  it('collapses whitespace', () => {
    expect(normalizeQuery('nuxt   seo   module')).toBe('module nuxt seo')
  })

  it('groups word-reordered queries', () => {
    const variants = ['nuxt seo', 'seo nuxt', 'SEO NUXT', 'nuxt-seo']
    const canonicals = variants.map(normalizeQuery)
    expect(new Set(canonicals).size).toBe(1)
  })

  it('applies synonym mapping (checker/tester/verifier → validator)', () => {
    expect(normalizeQuery('sitemap checker')).toBe('sitemap validator')
    expect(normalizeQuery('sitemap tester')).toBe('sitemap validator')
    expect(normalizeQuery('sitemap verifier')).toBe('sitemap validator')
    expect(normalizeQuery('sitemap validator')).toBe('sitemap validator')
  })

  it('applies synonym mapping (check/test/verify → validate)', () => {
    expect(normalizeQuery('check sitemap')).toBe('sitemap validate')
    expect(normalizeQuery('test sitemap')).toBe('sitemap validate')
    expect(normalizeQuery('verify sitemap')).toBe('sitemap validate')
  })

  it('applies synonym mapping (creator/builder/maker → generator)', () => {
    expect(normalizeQuery('sitemap creator')).toBe('generator sitemap')
    expect(normalizeQuery('sitemap builder')).toBe('generator sitemap')
    expect(normalizeQuery('sitemap generator')).toBe('generator sitemap')
  })

  it('strips noise words (online, free)', () => {
    expect(normalizeQuery('free sitemap validator online')).toBe('sitemap validator')
    expect(normalizeQuery('online schema checker')).toBe('schema validator')
  })

  it('depluralize: simple trailing s', () => {
    expect(normalizeQuery('nuxt scripts')).toBe(normalizeQuery('nuxt script'))
    expect(normalizeQuery('seo tools')).toBe('seo tool')
    expect(normalizeQuery('seo tool')).toBe('seo tool')
    expect(normalizeQuery('vue components')).toBe('component vue')
    expect(normalizeQuery('meta tags')).toBe('meta tag')
  })

  it('depluralize: -ies → -y', () => {
    expect(normalizeQuery('seo queries')).toBe('query seo')
    expect(normalizeQuery('categories')).toBe('category')
    expect(normalizeQuery('api strategies')).toBe('api strategy')
  })

  it('depluralize: -ses → -se', () => {
    expect(normalizeQuery('databases')).toBe('database')
    expect(normalizeQuery('responses')).toBe('response')
  })

  it('depluralize: -shes/-ches/-xes/-zes', () => {
    expect(normalizeQuery('cache matches')).toBe('cache match')
    expect(normalizeQuery('search indexes')).toBe('index search')
  })

  it('depluralize: preserves exceptions', () => {
    expect(normalizeQuery('css')).toBe('css')
    expect(normalizeQuery('kubernetes status')).toBe('kubernetes status')
    expect(normalizeQuery('redis')).toBe('redis')
    expect(normalizeQuery('analysis')).toBe('analysis')
    expect(normalizeQuery('wordpress')).toBe('wordpress')
    expect(normalizeQuery('express')).toBe('express')
    expect(normalizeQuery('postgres')).toBe('postgres')
    expect(normalizeQuery('canvas')).toBe('canvas')
  })

  it('handles real GSC query groups', () => {
    // nuxtseo (single token) differs from the rest, but the separated ones should match
    expect(normalizeQuery('nuxt-seo')).toBe(normalizeQuery('seo nuxt'))
    expect(normalizeQuery('nuxt/seo')).toBe(normalizeQuery('nuxt seo'))

    // sitemap validator group
    const sitemapValidatorVariants = [
      'sitemap validator',
      'validate sitemap',
      'sitemap checker',
      'sitemap tester',
      'sitemap verifier',
    ]
    const sitemapCanonicals = sitemapValidatorVariants.map(normalizeQuery)
    // checker/tester/verifier all map to validator
    expect(new Set([sitemapCanonicals[0], sitemapCanonicals[2], sitemapCanonicals[3], sitemapCanonicals[4]]).size).toBe(1)
    // validate vs validator are different words (verb vs noun) - both present
    expect(sitemapCanonicals[1]).toBe('sitemap validate')
  })

  it('handles empty/whitespace input', () => {
    expect(normalizeQuery('')).toBe('')
    expect(normalizeQuery('   ')).toBe('')
  })

  it('preserves unknown tokens as-is', () => {
    expect(normalizeQuery('react hooks tutorial')).toBe('hook react tutorial')
  })

  it('folds diacritics so accented variants group (café → cafe)', () => {
    expect(normalizeQuery('café')).toBe('cafe')
    expect(normalizeQuery('café')).toBe(normalizeQuery('cafe'))
    expect(normalizeQuery('naïve résumé')).toBe(normalizeQuery('naive resume'))
  })

  it('folds full-width / compatibility forms to ASCII', () => {
    expect(normalizeQuery('ｓｅｏ')).toBe('seo')
    expect(normalizeQuery('ｎｕｘｔ ｓｅｏ')).toBe(normalizeQuery('nuxt seo'))
  })

  it('empty-canonical guard: noise-only queries keep their tokens, never ""', () => {
    // Previously these stripped to '' (every noise query in one bogus group).
    expect(normalizeQuery('free')).toBe('free')
    expect(normalizeQuery('online')).toBe('online')
    expect(normalizeQuery('free online')).toBe('free online')
    // Noise is still stripped when real tokens remain.
    expect(normalizeQuery('free sitemap')).toBe('sitemap')
  })

  it('is idempotent over the new folding + guard paths', () => {
    for (const q of ['café', 'ｓｅｏ', 'free online', 'Nuxt-SEO Tools', 'naïve résumé']) {
      const once = normalizeQuery(q)
      expect(normalizeQuery(once)).toBe(once)
    }
  })

  it('singularizer no longer corrupts non-plural words (was plus→plu, lotus→lotu)', () => {
    expect(normalizeQuery('plus')).toBe('plus')
    expect(normalizeQuery('lotus')).toBe('lotus')
    expect(normalizeQuery('oasis')).toBe('oasis')
    expect(normalizeQuery('nemesis')).toBe('nemesis')
    expect(normalizeQuery('apparatus')).toBe('apparatus')
  })

  it('singularizer handles irregulars + uncountables correctly', () => {
    expect(normalizeQuery('analyses')).toBe('analysis') // irregular plural
    expect(normalizeQuery('series')).toBe('series') // uncountable (was → "sery")
    expect(normalizeQuery('news')).toBe('news')
    expect(normalizeQuery('buses')).toBe('bus')
  })

  it('preserves order for X→Y conversions (json to yaml ≠ yaml to json)', () => {
    expect(normalizeQuery('json to yaml')).toBe('json to yaml')
    expect(normalizeQuery('yaml to json')).toBe('yaml to json')
    expect(normalizeQuery('json to yaml')).not.toBe(normalizeQuery('yaml to json'))
    expect(normalizeQuery('px to rem')).toBe('px to rem')
    expect(normalizeQuery('celsius into fahrenheit')).toBe('celsius into fahrenheit')
  })

  it('still merges idiomatic "how/guide to …" and symmetric "vs" comparisons', () => {
    // 'to' after an idiom word is non-directional → sorts and merges.
    expect(normalizeQuery('how to validate sitemap')).toBe(normalizeQuery('sitemap validate how to'))
    // 'vs' is symmetric → both orders merge.
    expect(normalizeQuery('react vs vue')).toBe(normalizeQuery('vue vs react'))
  })

  it('is idempotent over the directional path', () => {
    for (const q of ['json to yaml', 'how to center a div', 'react vs vue', 'px to rem']) {
      const once = normalizeQuery(q)
      expect(normalizeQuery(once)).toBe(once)
    }
  })

  it('exposes a bumped NORMALIZER_VERSION for staleness tracking', () => {
    expect(NORMALIZER_VERSION).toBe(3)
  })
})
