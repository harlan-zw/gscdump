import { describe, expect, it } from 'vitest'
import { LONG_QUERY_REGEX, parseFilterArgs, QUESTION_REGEX, toLiveFilter, toLocalFilter } from '../src/filters'
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
    ['/post', 'https://example.com/blog/', 'https://example.com/blog/post'],
    ['/post', 'https://example.com/', 'https://example.com/post'],
    ['/post', 'https://example.com', 'https://example.com/post'],
  ])('expands %s under the prefix of the URL-prefix property %s', (page, siteUrl, expected) => {
    const filters = parseFilterArgs({ page })
    expect(leaves(toLiveFilter(filters, siteUrl))).toEqual([{ dimension: 'page', operator: 'equals', expression: expected }])
  })

  it('expands a stored path that already carries the property prefix once', () => {
    const filters = parseFilterArgs({ page: '/blog/post' })
    expect(leaves(toLiveFilter(filters, 'https://example.com/blog/'))).toEqual([{ dimension: 'page', operator: 'equals', expression: 'https://example.com/blog/post' }])
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

describe('--questions and --long-queries flags', () => {
  it.each([
    [true, 'includingRegex'],
    ['', 'includingRegex'],
    ['questions', 'includingRegex'],
    ['nonquestions', 'excludingRegex'],
  ])('parses --questions=%j into %s query regex', (value, operator) => {
    const filters = parseFilterArgs({ questions: value })
    expect(leaves(toLocalFilter(filters))).toEqual([{ dimension: 'query', operator, expression: QUESTION_REGEX }])
  })

  it('rejects unknown --questions values', () => {
    expect(() => parseFilterArgs({ questions: 'maybe' })).toThrow(/Invalid --questions/)
  })

  it('parses --long-queries into the 8+ word query regex', () => {
    const filters = parseFilterArgs({ 'long-queries': true })
    expect(leaves(toLocalFilter(filters))).toEqual([{ dimension: 'query', operator: 'includingRegex', expression: LONG_QUERY_REGEX }])
    const re = new RegExp(LONG_QUERY_REGEX)
    expect(re.test('one two three four five six seven')).toBe(false)
    expect(re.test('one two three four five six seven eight')).toBe(true)
  })
})
