import { describe, expect, it } from 'vitest'
import { INDEXING_ISSUE_FILTERS, isFragmentUrl } from '../src/core/indexing-issues'

describe('isFragmentUrl', () => {
  it('detects fragment anchors', () => {
    expect(isFragmentUrl('https://nuxtseo.com/docs/foo#bar')).toBe(true)
    expect(isFragmentUrl('https://nuxtseo.com/#hash')).toBe(true)
    expect(isFragmentUrl('https://nuxtseo.com/docs/foo?q=1#bar')).toBe(true)
    // Bare trailing '#' is still a fragment URL: Google resolves it to the
    // parent document, so inspecting it can never yield a distinct verdict.
    expect(isFragmentUrl('https://nuxtseo.com/docs/foo#')).toBe(true)
  })

  it('leaves ordinary URLs alone', () => {
    expect(isFragmentUrl('https://nuxtseo.com/docs/foo')).toBe(false)
    expect(isFragmentUrl('https://nuxtseo.com/docs/foo?q=1')).toBe(false)
    expect(isFragmentUrl('')).toBe(false)
  })

  it('tolerates non-string input at the boundary', () => {
    expect(isFragmentUrl(null as unknown as string)).toBe(false)
    expect(isFragmentUrl(undefined as unknown as string)).toBe(false)
  })

  it('agrees with the SQL predicate it replaces', () => {
    // The JS helper and the SQL filter must classify identically — that
    // equivalence is the whole point of centralising the rule.
    expect(INDEXING_ISSUE_FILTERS.fragment_url).toBe(`url LIKE '%#%'`)
    const sqlSaysFragment = (url: string) => url.includes('#')
    for (const url of [
      'https://nuxtseo.com/docs/foo',
      'https://nuxtseo.com/docs/foo#bar',
      'https://nuxtseo.com/#',
    ])
      expect(isFragmentUrl(url)).toBe(sqlSaysFragment(url))
  })
})
