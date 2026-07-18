import type { BuilderState } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { applyBuilderStatePostProcessing } from '../src/post-process'

describe('live API row post-processing', () => {
  it('applies nested dimension, metric, and top-level filters', () => {
    const rows = [
      { query: 'nuxt guide', page: '/guide', clicks: 8 },
      { query: 'vue guide', page: '/guide', clicks: 7 },
      { query: 'other', page: '/guide', clicks: 20 },
      { query: 'nuxt nested', page: '/docs/nuxt', clicks: 10 },
      { query: 'nuxt low', page: '/low', clicks: 2 },
    ]
    const state = {
      dimensions: ['query', 'page'],
      filter: {
        _filters: [
          { dimension: 'clicks', operator: 'metricGte', expression: '5' },
          { dimension: 'page', operator: 'topLevel', expression: '' },
        ],
        _nestedGroups: [{
          _filters: [
            { dimension: 'query', operator: 'includingRegex', expression: '^nuxt' },
            { dimension: 'query', operator: 'equals', expression: 'vue guide' },
          ],
          _groupType: 'or',
        }],
        _groupType: 'and',
      },
      orderBy: { column: 'clicks', dir: 'desc' },
    } as BuilderState

    expect(applyBuilderStatePostProcessing(rows, state).map(row => row.query))
      .toEqual(['nuxt guide', 'vue guide'])
  })

  it('uses stable bounded selection for small result pages', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      query: `q${index}`,
      clicks: (index * 17) % 11,
    }))
    const state = {
      dimensions: ['query'],
      orderBy: { column: 'clicks', dir: 'desc' },
      startRow: 4,
      rowLimit: 7,
    } satisfies BuilderState
    const expected = [...rows]
      .sort((a, b) => b.clicks - a.clicks)
      .slice(state.startRow, state.startRow + state.rowLimit)

    expect(applyBuilderStatePostProcessing(rows, state)).toEqual(expected)
  })

  it('does not sort when the requested limit is zero', () => {
    const rows = [{ clicks: 1 }, { clicks: 2 }]
    const state = {
      dimensions: [],
      rowLimit: 0,
    } satisfies BuilderState

    expect(applyBuilderStatePostProcessing(rows, state)).toEqual([])
    expect(rows).toEqual([{ clicks: 1 }, { clicks: 2 }])
  })

  it('preserves full-sort behavior for malformed non-finite metrics', () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({ query: `q${index}`, clicks: index }))
    rows[0]!.clicks = Number.NaN
    const state = {
      dimensions: ['query'],
      orderBy: { column: 'clicks', dir: 'desc' },
      rowLimit: 5,
    } satisfies BuilderState
    const expected = [...rows]
      .sort((left, right) => left.clicks === right.clicks ? 0 : left.clicks > right.clicks ? -1 : 1)
      .slice(0, state.rowLimit)

    expect(applyBuilderStatePostProcessing(rows, state)).toEqual(expected)
  })
})
