import { describe, expect, it } from 'vitest'
import { resolveTarget } from '../src/report/resolve-target'

describe('resolveTarget', () => {
  it('returns trusted input when no candidates supplied', () => {
    const out = resolveTarget({ kind: 'page', input: '/foo' })
    expect(out.exact).toBe('/foo')
    expect(out.matches).toEqual(['/foo'])
    expect(out.unresolved).toBe(false)
  })

  it('matches case-insensitively against candidates', () => {
    const out = resolveTarget({
      kind: 'query',
      input: 'WIDGETS',
      candidates: ['best widgets', 'cheap WIDGETS', 'unrelated'],
    })
    expect(out.matches).toEqual(['best widgets', 'cheap WIDGETS'])
    expect(out.exact).toBeNull()
  })

  it('promotes exact match to head of matches', () => {
    const out = resolveTarget({
      kind: 'page',
      input: '/blog',
      candidates: ['/blog/post', '/BLOG', '/help'],
    })
    expect(out.exact).toBe('/BLOG')
    expect(out.matches[0]).toBe('/BLOG')
    expect(out.matches).toContain('/blog/post')
  })

  it('marks unresolved when nothing matches', () => {
    const out = resolveTarget({
      kind: 'page',
      input: '/missing',
      candidates: ['/foo', '/bar'],
    })
    expect(out.unresolved).toBe(true)
    expect(out.matches).toEqual([])
  })

  it('returns unresolved on empty input', () => {
    const out = resolveTarget({ kind: 'page', input: '   ' })
    expect(out.unresolved).toBe(true)
  })
})
