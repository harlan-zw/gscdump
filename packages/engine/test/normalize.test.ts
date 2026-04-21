import { normalizeUrl } from 'gscdump/normalize'
import { describe, expect, it } from 'vitest'

describe('normalizeUrl', () => {
  it('strips protocol and host from an absolute URL', () => {
    expect(normalizeUrl('https://example.com/foo/bar')).toBe('/foo/bar')
  })

  it('keeps the root slash for a bare host URL', () => {
    expect(normalizeUrl('https://example.com/')).toBe('/')
  })

  it('preserves query + hash', () => {
    expect(normalizeUrl('https://example.com/x?y=1#z')).toBe('/x?y=1#z')
  })

  it('returns a relative path untouched', () => {
    expect(normalizeUrl('/foo/bar')).toBe('/foo/bar')
  })

  it('prefixes a missing slash when input looks like a relative path', () => {
    expect(normalizeUrl('foo/bar')).toBe('/foo/bar')
  })

  it('falls through for unparseable URL-like input', () => {
    expect(normalizeUrl('http://')).toBe('http://')
  })

  it('handles empty strings safely', () => {
    expect(normalizeUrl('')).toBe('')
  })
})
