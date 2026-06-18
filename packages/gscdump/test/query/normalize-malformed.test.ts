import { describe, expect, it } from 'vitest'
import { extractDateRange, extractMetricFilters, extractSpecialOperatorFilters, normalizeBuilderState, normalizeFilter } from '../../src/query/resolver'

// Regression: partner/CLI clients POST untrusted BuilderState bodies. Malformed
// shapes used to crash the receive edge with opaque TypeErrors (Sentry
// GSCDUMP-8 / GSCDUMP-9) instead of normalizing to a safe value. normalize* is
// the boundary parse — its output invariants (dimensions is an array; a filter,
// when present, has an iterable `_filters`) must hold for ANY input.
describe('normalizeBuilderState — malformed dimensions (GSCDUMP-8)', () => {
  it('coerces a missing dimensions field to an empty array', () => {
    const state = normalizeBuilderState({ metrics: ['clicks'] })
    expect(Array.isArray(state.dimensions)).toBe(true)
    expect(state.dimensions).toEqual([])
    // the crash site: `state.dimensions.includes('date')`
    expect(() => state.dimensions.includes('date')).not.toThrow()
  })

  it('coerces a non-array dimensions field to an empty array', () => {
    const state = normalizeBuilderState({ dimensions: 'page', metrics: ['clicks'] } as never)
    expect(state.dimensions).toEqual([])
  })

  it('coerces a non-array metrics field to an empty array', () => {
    const state = normalizeBuilderState({ dimensions: ['page'], metrics: 'clicks' } as never)
    expect(state.metrics).toEqual([])
  })
})

describe('normalizeFilter / extractDateRange — malformed filter (GSCDUMP-9)', () => {
  it('treats a filter whose _filters is not an array as no filter', () => {
    expect(normalizeFilter({ _filters: { dimension: 'date' } } as never)).toBeUndefined()
  })

  it('treats a plain object with no filter structure as no filter', () => {
    expect(normalizeFilter({ foo: 'bar' } as never)).toBeUndefined()
  })

  it('extractDateRange does not throw on a non-iterable _filters', () => {
    expect(() => extractDateRange({ _filters: 'nope' } as never)).not.toThrow()
    expect(extractDateRange({ _filters: 'nope' } as never)).toEqual({ startDate: undefined, endDate: undefined })
  })

  it('extractMetricFilters / extractSpecialOperatorFilters return [] on malformed input', () => {
    expect(extractMetricFilters({ _filters: 42 } as never)).toEqual([])
    expect(extractSpecialOperatorFilters({ _filters: null } as never)).toEqual([])
  })

  it('still passes a well-formed filter through unchanged', () => {
    const { startDate, endDate } = extractDateRange({
      _filters: [{ dimension: 'date', operator: 'between', expression: '2026-01-01', expression2: '2026-01-31' }],
    } as never)
    expect(startDate).toBe('2026-01-01')
    expect(endDate).toBe('2026-01-31')
  })
})
