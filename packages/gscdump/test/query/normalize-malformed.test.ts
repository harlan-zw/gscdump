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

  it('rejects a non-array dimensions field', () => {
    expect(normalizeBuilderStateResult({ dimensions: 'page' })).toMatchObject({ ok: false })
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
  it.each([
    () => normalizeFilter({ _filters: {} } as never),
    () => normalizeFilter({ foo: 'bar' } as never),
    () => extractDateRange({ _filters: 'nope' } as never),
    () => extractMetricFilters({ _filters: 42 } as never),
    () => extractSpecialOperatorFilters({ _filters: null } as never),
  ])('reports malformed filters through a typed error', (run) => {
    expect(run).toThrowError(expect.objectContaining({ queryError: expect.objectContaining({ kind: 'invalid-filter' }) }))
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

  it('rejects malformed ordering without changing the query', () => {
    expect(normalizeBuilderStateResult({ dimensions: ['page'], orderBy: {} })).toMatchObject({ ok: false })
    expect(normalizeBuilderStateResult({ dimensions: ['page'], orderBy: [] })).toMatchObject({ ok: false })
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
