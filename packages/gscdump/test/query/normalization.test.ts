import { describe, expect, it } from 'vitest'
import { between, clicks, date, gsc, gt, normalizeBuilderState, normalizeBuilderStateResult, page } from '../../src/query'
import { buildLogicalPlan } from '../../src/query/plan'

describe('query state serialization', () => {
  it('preserves row filters when building a plan from JSON', () => {
    const state = gsc.select(page)
      .where(between(date, '2026-01-01', '2026-01-31'))
      .prefilter(gt(clicks, 10))
      .getState()

    const plan = buildLogicalPlan(normalizeBuilderState(JSON.parse(JSON.stringify(state))))

    expect(plan.prefilters).toEqual([{ metric: 'clicks', operator: 'metricGt', expression: 10 }])
  })

  it.each(['filter', 'prefilter'])('rejects malformed nested groups in %s', (field) => {
    for (const _nestedGroups of [42, {}, [null], [undefined], [{}], [{ _filters: 42 }]]) {
      const result = normalizeBuilderStateResult({
        dimensions: ['page'],
        [field]: { _filters: [], _nestedGroups },
      })

      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-filter' } })
    }
  })

  it('rejects malformed row filter leaves', () => {
    const result = normalizeBuilderStateResult({
      dimensions: ['page'],
      prefilter: { _filters: [{ dimension: 'clicks', expression: 10 }] },
    })

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-filter' } })
  })
})

describe('query JSON boundary', () => {
  it.each([
    [],
    { dimensions: 'page' },
    { dimensions: [null] },
    { metrics: 'clicks' },
    { metrics: [1] },
    { searchType: 'typo' },
    { dataState: 'typo' },
    { aggregationType: 'typo' },
    { rowLimit: '10' },
    { startRow: -1 },
    { orderBy: { column: 'clicks', dir: 'typo' } },
  ])('returns a typed error for malformed state: %j', (state) => {
    expect(normalizeBuilderStateResult(state)).toMatchObject({ ok: false })
  })

  it.each([
    { _filters: 'invalid' },
    {},
    { type: 'and', filters: 42 },
    { type: 'or', filters: [null] },
    { type: 'and', filters: [{}] },
    { type: 'contains', column: 'page', value: 42 },
    { _filters: [{ dimension: 'page', operator: 'contains', expression: null }] },
    { _filters: [], _groupType: 'typo' },
  ])('rejects malformed filters without dropping constraints: %j', (filter) => {
    expect(normalizeBuilderStateResult({ dimensions: ['page'], filter }))
      .toMatchObject({ ok: false, error: { kind: 'invalid-filter' } })
  })

  it('rejects cyclic groups without a stack overflow', () => {
    const filter = { type: 'and', filters: [] as unknown[] }
    filter.filters.push(filter)
    expect(normalizeBuilderStateResult({ filter }))
      .toMatchObject({ ok: false, error: { kind: 'invalid-filter' } })
  })

  it('normalizes wire equality into an executable GSC filter', () => {
    const state = normalizeBuilderState({
      dimensions: ['page'],
      filter: { type: 'eq', column: 'page', value: '/docs' },
    })
    expect(state.filter?._filters).toEqual([{ dimension: 'page', operator: 'equals', expression: '/docs' }])
  })
})

describe('serialized filter constraints', () => {
  it.each([
    { type: 'eq', column: 'searchType', value: 'typo' },
    { type: 'or', filters: [] },
    { type: 'or', filters: [{ type: 'between', column: 'date', from: '2026-01-01', to: '2026-01-31' }] },
    { type: 'or', filters: [{ type: 'eq', column: 'searchType', value: 'web' }] },
    { type: 'and', filters: [{ type: 'or', filters: [] }] },
    { type: 'or', filters: [{ type: 'and', filters: [{ type: 'eq', column: 'page', value: '/docs' }] }] },
    { type: 'madeUp', column: 'page', value: '/docs' },
  ])('rejects constraints that cannot retain their meaning: %j', (filter) => {
    expect(normalizeBuilderStateResult({ dimensions: ['page'], filter }))
      .toMatchObject({ ok: false, error: { kind: 'invalid-filter' } })
  })

  it('rejects unknown dimensions', () => {
    expect(normalizeBuilderStateResult({ dimensions: ['qurey'] })).toMatchObject({ ok: false })
  })

  it('rejects conflicting ordering options', () => {
    expect(normalizeBuilderStateResult({ orderBy: { column: 'clicks', dir: 'asc', desc: true } }))
      .toMatchObject({ ok: false })
  })
})

describe('serialized expression values', () => {
  it.each([
    { dimension: 'date', operator: 'gt', expression: 'not-a-date' },
    { dimension: 'date', operator: 'between', expression: '2026-02-30', expression2: '2026-03-31' },
    { dimension: 'page', operator: 'gte', expression: '2026-01-01' },
    { dimension: 'clicks', operator: 'metricGt', expression: 'NaN' },
  ])('rejects invalid expressions before date arithmetic or SQL: %j', (leaf) => {
    expect(normalizeBuilderStateResult({ filter: { _filters: [leaf] } }))
      .toMatchObject({ ok: false, error: { kind: 'invalid-filter' } })
  })
})
