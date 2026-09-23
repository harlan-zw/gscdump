import type { SiteCandidate, SiteResolution } from '../../src/core/property'
import { describe, expect, it } from 'vitest'
import { resolveSiteInput } from '../../src/core/property'

const sites = (...siteUrls: string[]): SiteCandidate[] => siteUrls.map(siteUrl => ({ siteUrl }))
const resolved = (siteUrl: string, via: 'exact' | 'host' = 'host'): SiteResolution => ({ kind: 'resolved', siteUrl, via })

describe('resolveSiteInput', () => {
  const domain = sites('sc-domain:example.com')
  it.each([
    ['example.com'],
    ['https://example.com'],
    ['https://example.com/'],
    ['http://example.com'],
    ['www.example.com'],
    ['Example.COM'],
    ['  example.com/  '],
  ])('resolves %j to the domain property', (input) => {
    expect(resolveSiteInput(input, domain)).toEqual(resolved('sc-domain:example.com'))
  })

  it.each([
    ['sc-domain:example.com', 'sc-domain:example.com'],
    ['SC-DOMAIN:Example.com', 'sc-domain:example.com'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com/docs', 'https://example.com/docs/'],
  ])('short-circuits the exact Site %j', (input, siteUrl) => {
    const candidates = sites('sc-domain:example.com', 'https://example.com/', 'https://example.com/docs/')
    expect(resolveSiteInput(input, candidates)).toEqual(resolved(siteUrl, 'exact'))
  })

  it('resolves a URL-prefix property from a bare input', () => {
    expect(resolveSiteInput('example.com', sites('https://www.example.com/'))).toEqual(resolved('https://www.example.com/'))
  })

  it('resolves a URL-prefix property with a path from a bare input with that path', () => {
    expect(resolveSiteInput('example.com/docs', sites('https://example.com/docs/', 'https://other.com/'))).toEqual(resolved('https://example.com/docs/'))
  })

  it.each([
    ['nuxt.com', 'https://scripts.nuxt.com/'],
    ['seo.com', 'sc-domain:nuxtseo.com'],
    ['unjs.io', 'https://unhead.unjs.io/'],
    ['example.co', 'sc-domain:example.com'],
  ])('never matches %j by substring', (input, siteUrl) => {
    expect(resolveSiteInput(input, sites(siteUrl))).toEqual({ kind: 'not-found', input, known: [siteUrl] })
  })

  it('prefers the domain property when neither Site has Store data', () => {
    expect(resolveSiteInput('example.com', sites('https://example.com/', 'sc-domain:example.com'))).toEqual(resolved('sc-domain:example.com'))
  })

  it('prefers the Site with Store data over the domain property', () => {
    const candidates = [{ siteUrl: 'sc-domain:example.com' }, { siteUrl: 'https://example.com/', inStore: true }]
    expect(resolveSiteInput('example.com', candidates)).toEqual(resolved('https://example.com/'))
  })

  it('merges duplicate candidates and keeps their Store flag', () => {
    const candidates = [{ siteUrl: 'https://example.com/', inStore: true }, { siteUrl: 'sc-domain:example.com' }, { siteUrl: 'https://example.com/' }]
    expect(resolveSiteInput('example.com', candidates)).toEqual(resolved('https://example.com/'))
  })

  it('prefers the URL-prefix property whose www matches the input, then HTTPS', () => {
    const candidates = sites('http://example.com/', 'https://example.com/', 'https://www.example.com/')
    expect(resolveSiteInput('www.example.com', candidates)).toEqual(resolved('https://www.example.com/'))
    expect(resolveSiteInput('example.com', candidates)).toEqual(resolved('https://example.com/'))
  })

  it('returns ambiguous when two Store Sites share a root after every tie-break', () => {
    const candidates = [{ siteUrl: 'sc-domain:Example.com', inStore: true }, { siteUrl: 'sc-domain:example.com', inStore: true }]
    expect(resolveSiteInput('https://example.com/', candidates)).toEqual({
      kind: 'ambiguous',
      input: 'https://example.com/',
      candidates: ['sc-domain:Example.com', 'sc-domain:example.com'],
    })
    expect(resolveSiteInput('sc-domain:example.com', candidates)).toEqual(resolved('sc-domain:example.com', 'exact'))
  })

  it('prefers the domain property whose www matches the input', () => {
    const candidates = sites('sc-domain:example.com', 'sc-domain:www.example.com')
    expect(resolveSiteInput('https://www.example.com/', candidates)).toEqual(resolved('sc-domain:www.example.com'))
  })

  it('returns ambiguous for an exact match that differs only by case', () => {
    expect(resolveSiteInput('https://example.com/A/', sites('https://example.com/a/', 'https://example.com/A/'))).toEqual(resolved('https://example.com/A/', 'exact'))
    expect(resolveSiteInput('https://example.com/a', sites('https://example.com/b/', 'https://Example.com/a/', 'https://example.com/A/'))).toEqual({
      kind: 'ambiguous',
      input: 'https://example.com/a',
      candidates: ['https://Example.com/a/', 'https://example.com/A/'],
    })
  })

  it('reports a subdomain covered by a domain property instead of rewriting it', () => {
    expect(resolveSiteInput('blog.example.com', sites('sc-domain:example.com'))).toEqual({
      kind: 'covered-by-parent',
      input: 'blog.example.com',
      parent: 'sc-domain:example.com',
    })
  })

  it('picks the closest parent', () => {
    expect(resolveSiteInput('a.b.example.com', sites('sc-domain:example.com', 'sc-domain:b.example.com'))).toEqual({
      kind: 'covered-by-parent',
      input: 'a.b.example.com',
      parent: 'sc-domain:b.example.com',
    })
  })

  it('reports a path covered by its root Site', () => {
    expect(resolveSiteInput('example.com/blog', sites('https://example.com/'))).toEqual({
      kind: 'covered-by-parent',
      input: 'example.com/blog',
      parent: 'https://example.com/',
    })
  })

  it('never covers a subdomain with a URL-prefix property', () => {
    expect(resolveSiteInput('blog.example.com', sites('https://example.com/'))).toEqual({
      kind: 'not-found',
      input: 'blog.example.com',
      known: ['https://example.com/'],
    })
  })

  it.each([[''], ['   '], ['https://']])('returns not-found for the empty input %j', (input) => {
    expect(resolveSiteInput(input, domain)).toEqual({ kind: 'not-found', input, known: ['sc-domain:example.com'] })
  })
})
