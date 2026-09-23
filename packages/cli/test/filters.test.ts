import { describe, expect, it } from 'vitest'
import { parseFilterArgs, toLiveFilter, toLocalFilter } from '../src/filters'
import { parseWindowFlags } from '../src/window'

function leaves(filter: ReturnType<typeof toLiveFilter>) {
  return (filter as unknown as { _filters: unknown[] })._filters
}

describe('--page parsing', () => {
  it('compares a full URL as a path in the Store', () => {
    const filters = parseFilterArgs({ page: 'https://example.com/blog/post?ref=x' })
    expect(leaves(toLocalFilter(filters))).toEqual([{ dimension: 'page', operator: 'equals', expression: '/blog/post' }])
  })

  it('keeps the host a full URL names for live reads', () => {
    const filters = parseFilterArgs({ page: 'https://blog.example.com/post' })
    expect(leaves(toLiveFilter(filters, 'sc-domain:example.com'))).toEqual([{ dimension: 'page', operator: 'equals', expression: 'https://blog.example.com/post' }])
  })

  it.each([
    ['https://example.com/blog/', 'https://example.com/blog/post'],
    ['https://example.com/', 'https://example.com/post'],
    ['https://example.com', 'https://example.com/post'],
  ])('expands a path under the prefix of the URL-prefix property %s', (siteUrl, expected) => {
    const filters = parseFilterArgs({ page: '/post' })
    expect(leaves(toLiveFilter(filters, siteUrl))).toEqual([{ dimension: 'page', operator: 'equals', expression: expected }])
  })

  it.each([
    ['/post', 'includingRegex'],
    ['!/post', 'excludingRegex'],
  ])('matches %s on any host of a domain property', (raw, operator) => {
    const filters = parseFilterArgs({ page: raw })
    expect(leaves(toLiveFilter(filters, 'sc-domain:example.com'))).toEqual([{ dimension: 'page', operator, expression: '^https?://[^/]+/post$' }])
  })
})

describe('window flags', () => {
  const defaults = { preset: 'last-28d', comparison: 'none' } as const

  it('rejects a preset period together with explicit dates', () => {
    const result = parseWindowFlags({ period: '7d', start: '2026-01-01' }, defaults, '2026-03-20')
    expect(result).toMatchObject({ ok: false, error: { kind: 'period-conflict' } })
  })

  it('resolves a quarter-to-date window on the anchor', () => {
    const result = parseWindowFlags({ period: 'qtd' }, defaults, '2026-05-10')
    expect(result).toMatchObject({ ok: true, value: { start: '2026-04-01', end: '2026-05-10', days: 40 } })
  })
})
