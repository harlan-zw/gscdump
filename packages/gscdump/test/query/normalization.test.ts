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
