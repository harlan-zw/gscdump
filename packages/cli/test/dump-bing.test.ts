import { describe, expect, it } from 'vitest'
import { parseBingDumpOptions } from '../src/bing-data'
import { matchBingSites } from '../src/dump-bing'

describe('matchBingSites', () => {
  const bing = ['https://example.com/', 'https://www.example.com/', 'https://other.com/']

  it('keeps Bing sites inside a domain property or equal to a URL-prefix property', () => {
    expect(matchBingSites(bing, ['sc-domain:example.com'])).toEqual(['https://example.com/', 'https://www.example.com/'])
    expect(matchBingSites(bing, ['https://other.com/'])).toEqual(['https://other.com/'])
    expect(matchBingSites(bing, ['sc-domain:missing.com'])).toEqual([])
  })

  it('keeps every Bing site for an all-sites dump', () => {
    expect(matchBingSites(bing, 'all')).toEqual(bing)
  })
})

describe('parseBingDumpOptions', () => {
  it('includes crawl issues by default and leaves them out of a dated export', () => {
    expect(parseBingDumpOptions({}).datasets).toContain('crawl-issues')
    expect(parseBingDumpOptions({}).datasetsExplicit).toBe(false)
    expect(parseBingDumpOptions({ start: '2026-01-01' }).datasets).not.toContain('crawl-issues')
    expect(parseBingDumpOptions({ datasets: 'traffic' })).toMatchObject({ datasets: ['traffic'], datasetsExplicit: true })
  })
})
