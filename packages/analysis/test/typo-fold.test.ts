import { describe, expect, it } from 'vitest'
import {
  damerauLevenshteinBounded,
  foldCanonicalTypos,
  resolveCanonicalTypoFolds,
} from '../src/query/typo-fold'

describe('damerauLevenshteinBounded', () => {
  it('computes exact distance including adjacent transpositions within bound', () => {
    expect(damerauLevenshteinBounded('schema', 'schema', 2)).toBe(0)
    expect(damerauLevenshteinBounded('schema', 'schmea', 1)).toBe(1)
    expect(damerauLevenshteinBounded('screaming', 'screeming', 1)).toBe(1)
    expect(damerauLevenshteinBounded('ninajirachi', 'ninajaraci', 2)).toBe(2)
    expect(damerauLevenshteinBounded('ninajirachi', 'totallydiff', 2)).toBe(3)
  })
})

describe('foldCanonicalTypos', () => {
  it('folds spacing, typo, and transposed variants into highest-impression head anchors', () => {
    const entries = [
      { canonical: 'ninajirachi', impressions: 5000, clicks: 400 },
      { canonical: 'nina jirachi', impressions: 600, clicks: 40 },
      { canonical: 'ninajarachi', impressions: 200, clicks: 15 },
      { canonical: 'nina jiraci', impressions: 80, clicks: 5 },
      { canonical: 'hotel street wall', impressions: 3000, clicks: 200 },
      { canonical: 'wallstreethotel', impressions: 700, clicks: 50 },
      { canonical: 'hotel streeet wall', impressions: 90, clicks: 4 },
      { canonical: 'jet screaming', impressions: 1500, clicks: 100 },
      { canonical: 'acreeming jet', impressions: 40, clicks: 2 },
      { canonical: 'schema validator', impressions: 1000, clicks: 80 },
      { canonical: 'schmea validator', impressions: 60, clicks: 3 },
    ]
    const { mapping, matches } = resolveCanonicalTypoFolds(entries)

    expect(mapping.get('nina jirachi')).toBe('ninajirachi')
    expect(mapping.get('ninajarachi')).toBe('ninajirachi')
    expect(mapping.get('nina jiraci')).toBe('ninajirachi')
    expect(mapping.get('wallstreethotel')).toBe('hotel street wall')
    expect(mapping.get('hotel streeet wall')).toBe('hotel street wall')
    expect(mapping.get('acreeming jet')).toBe('jet screaming')
    expect(mapping.get('schmea validator')).toBe('schema validator')
    expect(matches.find(m => m.canonical === 'nina jirachi')).toMatchObject({ reason: 'spaceless', distance: 0 })
    expect(matches.find(m => m.canonical === 'wallstreethotel')).toMatchObject({ reason: 'spaceless', distance: 0 })
    expect(matches.find(m => m.canonical === 'schmea validator')).toMatchObject({ reason: 'edit', distance: 1 })
  })

  it('folds spaceless compound queries into bag-of-words sorted spaced anchors without merging anagrams', () => {
    const map = foldCanonicalTypos([
      { canonical: 'hotel street wall', impressions: 3000 },
      { canonical: 'wallstreethotel', impressions: 700 },
      { canonical: 'hotel wallstreet', impressions: 400 },
      { canonical: 'jirachi nina', impressions: 2000 },
      { canonical: 'ninajirachi', impressions: 500 },
      { canonical: 'jiraci nina', impressions: 100 },
      { canonical: 'nuxt seo', impressions: 2000 },
      { canonical: 'nuxtseo', impressions: 900 },
      { canonical: 'listen', impressions: 1000 },
      { canonical: 'silent', impressions: 800 },
    ])
    expect(map.get('wallstreethotel')).toBe('hotel street wall')
    expect(map.get('hotel wallstreet')).toBe('hotel street wall')
    expect(map.get('ninajirachi')).toBe('jirachi nina')
    expect(map.get('jiraci nina')).toBe('jirachi nina')
    expect(map.get('nuxtseo')).toBe('nuxt seo')
    expect(map.get('silent')).toBe('silent')
  })

  it('blocks numeric/version, polarity, directional, and short-token false merges', () => {
    const entries = [
      // Numeric/version differences
      { canonical: 'nuxt 3', impressions: 5000 },
      { canonical: 'nuxt 4', impressions: 4000 },
      { canonical: 'seo guide 2025', impressions: 2000 },
      { canonical: 'seo guide 2026', impressions: 1500 },
      { canonical: 'http 404 error', impressions: 1000 },
      { canonical: 'http 504 error', impressions: 800 },
      // Polarity differences
      { canonical: 'index robot', impressions: 1000 },
      { canonical: 'noindex robot', impressions: 900 },
      { canonical: 'follow link', impressions: 1000 },
      { canonical: 'nofollow link', impressions: 900 },
      // Directional conversions preserved by normalizeQuery
      { canonical: 'png to jpg', impressions: 1000 },
      { canonical: 'jpg to png', impressions: 900 },
      // Short-token and acronym collisions
      { canonical: 'seo', impressions: 1000 },
      { canonical: 'geo', impressions: 900 },
      { canonical: 'mode nuxt ssr', impressions: 1000 },
      { canonical: 'mode nuxt ssg', impressions: 900 },
      { canonical: 'nuxt page seo', impressions: 1000 },
      { canonical: 'nuxt page geo', impressions: 900 },
      { canonical: 'data nuxt tag', impressions: 1000 },
      { canonical: 'meta nuxt tag', impressions: 900 },
      // Distinct topics differing by a standalone 2-letter token
      { canonical: 'image nuxt', impressions: 1000 },
      { canonical: 'image nuxt og', impressions: 900 },
      { canonical: 'doc nuxt', impressions: 1000 },
      { canonical: 'doc nuxt ui', impressions: 900 },
      { canonical: 'fashion week', impressions: 1000 },
      { canonical: 'fashion ny week', impressions: 900 },
    ]
    const map = foldCanonicalTypos(entries)
    for (const entry of entries)
      expect(map.get(entry.canonical), `unexpected fold for "${entry.canonical}"`).toBe(entry.canonical)
  })

  it('prevents transitive chaining and stays invariant to input row order', () => {
    const forward = [
      { canonical: 'screaming', impressions: 1000 },
      { canonical: 'screeming', impressions: 500 },
      { canonical: 'screeeming', impressions: 200 },
      { canonical: 'screeeeming', impressions: 100 },
      { canonical: 'screeeeeming', impressions: 50 },
    ]
    const reversed = [...forward].reverse()

    const mapForward = foldCanonicalTypos(forward, { maxEditDistance: 1 })
    const mapReversed = foldCanonicalTypos(reversed, { maxEditDistance: 1 })

    expect([...mapForward.entries()].sort()).toEqual([...mapReversed.entries()].sort())
    // Only distance <= 1 from head anchor `screaming` folds; `screeeming` (dist 2) becomes its own anchor,
    // and `screeeeeming` cannot chain through `screeming` into `screaming`.
    expect(mapForward.get('screeming')).toBe('screaming')
    expect(mapForward.get('screeeming')).toBe('screeeming')
    expect(mapForward.get('screeeeming')).toBe('screeeming')
  })

  it('scales sub-linearly on brand-heavy multi-word queries without quadratic blowup', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'
    const entries: Array<{ canonical: string, impressions: number }> = []
    for (let i = 0; i < 3000; i++) {
      // Distinct 8-char words sharing one brand token `nuxt`.
      const w = [
        alphabet[i % 26],
        alphabet[Math.floor(i / 26) % 26],
        alphabet[Math.floor(i / 676) % 26],
        alphabet[(i * 7) % 26],
        alphabet[(i * 11) % 26],
        alphabet[(i * 13) % 26],
        alphabet[(i * 17) % 26],
        alphabet[(i * 19) % 26],
      ].join('')
      entries.push({ canonical: `nuxt ${w}`, impressions: 3000 - i })
    }
    // Add one genuine 2-edit typo of the top branded query to verify recall is preserved.
    const topWord = entries[0]!.canonical.split(' ')[1]!
    const typo = `nuxt ${topWord.slice(0, 3)}zz${topWord.slice(5)}`
    entries.push({ canonical: typo, impressions: 1 })

    const t0 = performance.now()
    const map = foldCanonicalTypos(entries)
    const elapsedMs = performance.now() - t0

    expect(map.get(typo)).toBe(entries[0]!.canonical)
    expect(elapsedMs).toBeLessThan(1500)
  })

  it('folds directional typos and compound spacing only into the matching direction', () => {
    const map = foldCanonicalTypos([
      { canonical: 'markdown to html', impressions: 1000 },
      { canonical: 'html to markdown', impressions: 800 },
      { canonical: 'html to markdwon', impressions: 50 },
      { canonical: 'png to jpg', impressions: 1000 },
      { canonical: 'jpgto png', impressions: 50 },
    ])
    expect(map.get('html to markdwon')).toBe('html to markdown')
    expect(map.get('html to markdown')).toBe('html to markdown')
    expect(map.get('jpgto png')).toBe('jpgto png')
  })

  it('bounds edit-index memory via maxEditAnchors while keeping head edit folds and all spaceless folds', () => {
    const map = foldCanonicalTypos([
      { canonical: 'nuxt schema', impressions: 5000 },
      { canonical: 'tail topic alpha', impressions: 50 },
      { canonical: 'tail topic beta', impressions: 20 },
      { canonical: 'nuxt schmea', impressions: 10 },
      { canonical: 'tail topic btea', impressions: 5 },
      { canonical: 'tailtopicalpha', impressions: 5 },
    ], { maxEditAnchors: 1 })

    // Top anchor (`nuxt schema`) is edit-indexed, so tail typo folds into it.
    expect(map.get('nuxt schmea')).toBe('nuxt schema')
    // Exact spaceless folding still works beyond maxEditAnchors.
    expect(map.get('tailtopicalpha')).toBe('tail topic alpha')
    // Lower-ranked anchor (`tail topic beta`) is not edit-indexed when maxEditAnchors = 1.
    expect(map.get('tail topic btea')).toBe('tail topic btea')
  })
})
