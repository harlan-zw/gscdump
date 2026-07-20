import { describe, expect, it } from 'vitest'
import { extractDateRange, extractMetricFilters, extractSpecialOperatorFilters, normalizeBuilderState, normalizeBuilderStateResult, normalizeFilter } from '../../src/query/resolver'

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

  it('leaves an omitted metrics field as undefined (the all-metrics default sentinel)', () => {
    // plan.ts: `state.metrics ? [...] : [clicks,impressions,ctr,position]`.
    // Coercing undefined → [] (truthy) would select NO metrics and break
    // `ORDER BY <metric>` with a 40004 (GSCDUMP-A/C). Must stay undefined.
    const state = normalizeBuilderState({ dimensions: ['page'], orderBy: { column: 'impressions', dir: 'desc' } } as never)
    expect(state.metrics).toBeUndefined()
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

// Boundary hardening promoted from gscdump.com's normalize-builder-state
// wrapper: clients sent alternative `orderBy` shapes and hand-built `_filters`
// leaves that reached the engine malformed and surfaced as opaque 500s
// (Sentry GSCDUMP-1M / GSCDUMP-Q). The package normalizer is now the single
// parse point, so consumers can drop their local wrappers.
describe('normalizeBuilderState — orderBy coercion (GSCDUMP-1M)', () => {
  it('coerces the legacy array-of-specs shape to { column, dir }', () => {
    // The exact shape from GSCDUMP-1M: `orderBy: [{ column, desc: true }]`.
    const state = normalizeBuilderState({
      dimensions: ['page'],
      orderBy: [{ column: 'impressions', desc: true }],
    })
    expect(state.orderBy).toEqual({ column: 'impressions', dir: 'desc' })
  })

  it('maps { column, desc: false } to ascending', () => {
    const state = normalizeBuilderState({ dimensions: ['page'], orderBy: { column: 'clicks', desc: false } })
    expect(state.orderBy).toEqual({ column: 'clicks', dir: 'asc' })
  })

  it('preserves the canonical { column, dir } shape (case-insensitive dir)', () => {
    expect(normalizeBuilderState({ dimensions: ['page'], orderBy: { column: 'clicks', dir: 'desc' } }).orderBy)
      .toEqual({ column: 'clicks', dir: 'desc' })
    expect(normalizeBuilderState({ dimensions: ['page'], orderBy: { column: 'clicks', dir: 'ASC' } }).orderBy)
      .toEqual({ column: 'clicks', dir: 'asc' })
  })

  it('drops orderBy with no valid column so the engine uses its default ordering', () => {
    expect(normalizeBuilderState({ dimensions: ['page'], orderBy: {} }).orderBy).toBeUndefined()
    expect(normalizeBuilderState({ dimensions: ['page'], orderBy: [] }).orderBy).toBeUndefined()
    expect(normalizeBuilderState({ dimensions: ['page'] }).orderBy).toBeUndefined()
  })
})

describe('normalizeBuilderState — filter leaf validation (GSCDUMP-Q)', () => {
  it('returns an invalid-filter error for a leaf missing its operator', () => {
    // Already-internal `_filters` form is passed through by normalizeFilter
    // without per-leaf validation; a leaf with no `operator` used to reach the
    // engine and crash on `f.operator.startsWith`.
    const result = normalizeBuilderStateResult({
      dimensions: ['page'],
      filter: { _filters: [{ dimension: 'page', expression: 'x' }] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error.kind).toBe('invalid-filter')
  })

  it('returns an invalid-filter error for a leaf missing its dimension', () => {
    const result = normalizeBuilderStateResult({
      dimensions: ['page'],
      filter: { _filters: [{ operator: 'contains', expression: 'x' }] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error.kind).toBe('invalid-filter')
  })

  it('validates nested groups too', () => {
    const result = normalizeBuilderStateResult({
      dimensions: ['page'],
      filter: {
        _filters: [{ dimension: 'query', operator: 'contains', expression: 'ok' }],
        _nestedGroups: [{ _filters: [{ dimension: 'page', expression: 'bad' }] }],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error.kind).toBe('invalid-filter')
  })

  it('the throwing wrapper carries the typed queryError so hosts can map to a 4xx', () => {
    expect(() => normalizeBuilderState({
      dimensions: ['page'],
      filter: { _filters: [{ dimension: 'page', expression: 'x' }] },
    })).toThrowError(expect.objectContaining({ queryError: expect.objectContaining({ kind: 'invalid-filter' }) }))
  })

  it('passes a well-formed filter through unchanged', () => {
    const state = normalizeBuilderState({
      dimensions: ['page'],
      filter: { _filters: [{ dimension: 'query', operator: 'contains', expression: 'seo' }] },
    })
    expect(state.filter).toMatchObject({ _filters: [{ dimension: 'query', operator: 'contains', expression: 'seo' }] })
  })
})
