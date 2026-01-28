import { describe, expect, it } from 'vitest'
import { gsc } from '../../src/query/builder'
import { clicks, ctr, date, impressions, page, position, query, queryCanonical } from '../../src/query/columns'
import { and, between, contains, gte, lte, topLevel } from '../../src/query/operators'
import { extractMetricFilters, extractSpecialOperatorFilters } from '../../src/query/resolver'

describe('metric columns', () => {
  it('clicks column has metric property', () => {
    expect(clicks.metric).toBe('clicks')
  })

  it('impressions column has metric property', () => {
    expect(impressions.metric).toBe('impressions')
  })

  it('ctr column has metric property', () => {
    expect(ctr.metric).toBe('ctr')
  })

  it('position column has metric property', () => {
    expect(position.metric).toBe('position')
  })
})

describe('queryCanonical dimension', () => {
  it('queryCanonical column has dimension property', () => {
    expect(queryCanonical.dimension).toBe('queryCanonical')
  })

  it('can be used in select', () => {
    const state = gsc
      .select(queryCanonical, clicks, impressions)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .getState()

    expect(state.dimensions).toEqual(['queryCanonical'])
    expect(state.metrics).toEqual(['clicks', 'impressions'])
  })
})

describe('mixed select (dimensions + metrics)', () => {
  it('partitions dimensions and metrics from column objects', () => {
    const state = gsc
      .select(page, clicks, impressions, ctr, position)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .getState()

    expect(state.dimensions).toEqual(['page'])
    expect(state.metrics).toEqual(['clicks', 'impressions', 'ctr', 'position'])
  })

  it('handles multiple dimensions with metrics', () => {
    const state = gsc
      .select(page, query, clicks, impressions)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .getState()

    expect(state.dimensions).toEqual(['page', 'query'])
    expect(state.metrics).toEqual(['clicks', 'impressions'])
  })

  it('metrics is undefined when only string dimensions used', () => {
    const state = gsc
      .select('page', 'query')
      .where(between(date, '2024-01-01', '2024-01-31'))
      .getState()

    expect(state.dimensions).toEqual(['page', 'query'])
    expect(state.metrics).toBeUndefined()
  })

  it('metrics is undefined when only column dimensions used', () => {
    const state = gsc
      .select(page, query)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .getState()

    expect(state.dimensions).toEqual(['page', 'query'])
    expect(state.metrics).toBeUndefined()
  })

  it('backwards compatible with string dimension names', () => {
    const body = gsc
      .select('page', 'device')
      .where(between(date, '2024-01-01', '2024-01-31'))
      .toBody()

    expect(body.dimensions).toEqual(['page', 'device'])
  })

  it('select with date column and metrics', () => {
    const state = gsc
      .select(date, clicks, impressions, ctr, position)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .getState()

    expect(state.dimensions).toEqual(['date'])
    expect(state.metrics).toEqual(['clicks', 'impressions', 'ctr', 'position'])
  })
})

describe('orderBy', () => {
  it('sets orderBy with metric column', () => {
    const state = gsc
      .select(page, clicks, impressions)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .orderBy(clicks, 'desc')
      .getState()

    expect(state.orderBy).toEqual({ column: 'clicks', dir: 'desc' })
  })

  it('sets orderBy ascending', () => {
    const state = gsc
      .select(query, position)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .orderBy(position, 'asc')
      .getState()

    expect(state.orderBy).toEqual({ column: 'position', dir: 'asc' })
  })

  it('orderBy can be chained in any order', () => {
    const state = gsc
      .orderBy(impressions, 'desc')
      .select(page, clicks, impressions)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .limit(100)
      .getState()

    expect(state.orderBy).toEqual({ column: 'impressions', dir: 'desc' })
    expect(state.rowLimit).toBe(100)
  })
})

describe('metric operators', () => {
  it('gte creates metricGte filter for metric column', () => {
    const f = gte(impressions, 100)
    expect(f._filters[0]).toEqual({
      dimension: 'impressions',
      operator: 'metricGte',
      expression: '100',
    })
  })

  it('lte creates metricLte filter for metric column', () => {
    const f = lte(position, 20)
    expect(f._filters[0]).toEqual({
      dimension: 'position',
      operator: 'metricLte',
      expression: '20',
    })
  })

  it('gte still works for date dimension', () => {
    const f = gte(date, '2024-01-01')
    expect(f._filters[0]).toEqual({
      dimension: 'date',
      operator: 'gte',
      expression: '2024-01-01',
    })
  })

  it('between creates metricBetween for metric column', () => {
    const f = between(position, 4, 20)
    expect(f._filters[0]).toEqual({
      dimension: 'position',
      operator: 'metricBetween',
      expression: '4',
      expression2: '20',
    })
  })

  it('between still works for date dimension', () => {
    const f = between(date, '2024-01-01', '2024-01-31')
    expect(f._filters[0]).toEqual({
      dimension: 'date',
      operator: 'between',
      expression: '2024-01-01',
      expression2: '2024-01-31',
    })
  })

  it('metric filters are excluded from GSC API body', () => {
    const body = gsc
      .select(query, clicks, impressions, position)
      .where(and(
        between(date, '2024-01-01', '2024-01-31'),
        gte(impressions, 100),
        lte(position, 20),
      ))
      .toBody()

    // metric filters should NOT appear in dimensionFilterGroups
    expect(body.dimensionFilterGroups).toBeUndefined()
  })

  it('metric filters preserved alongside dimension filters in API body', () => {
    const body = gsc
      .select(query, clicks, impressions, position)
      .where(and(
        between(date, '2024-01-01', '2024-01-31'),
        contains(page, '/blog/'),
        gte(impressions, 100),
      ))
      .toBody()

    // Only the dimension filter (contains) should be in the API body
    expect(body.dimensionFilterGroups).toHaveLength(1)
    expect(body.dimensionFilterGroups![0].filters).toHaveLength(1)
    expect(body.dimensionFilterGroups![0].filters[0].dimension).toBe('page')
  })

  it('metric filters are accessible via getState', () => {
    const state = gsc
      .select(query, clicks, impressions, position)
      .where(and(
        between(date, '2024-01-01', '2024-01-31'),
        gte(impressions, 100),
        lte(position, 20),
      ))
      .getState()

    // Metric filters should be in the state filter
    const metricFilters = state.filter!._filters.filter(
      f => f.operator.startsWith('metric'),
    )
    expect(metricFilters).toHaveLength(2)
  })
})

describe('extractMetricFilters', () => {
  it('extracts metric filters from filter', () => {
    const state = gsc
      .select(query, clicks)
      .where(and(
        between(date, '2024-01-01', '2024-01-31'),
        gte(impressions, 100),
        lte(position, 20),
        contains(page, '/blog/'),
      ))
      .getState()

    const metricFilters = extractMetricFilters(state.filter)
    expect(metricFilters).toHaveLength(2)
    expect(metricFilters[0]).toEqual({
      dimension: 'impressions',
      operator: 'metricGte',
      expression: '100',
    })
    expect(metricFilters[1]).toEqual({
      dimension: 'position',
      operator: 'metricLte',
      expression: '20',
    })
  })

  it('returns empty array when no metric filters', () => {
    const state = gsc
      .select(query, clicks)
      .where(between(date, '2024-01-01', '2024-01-31'))
      .getState()

    expect(extractMetricFilters(state.filter)).toEqual([])
  })

  it('returns empty array for undefined filter', () => {
    expect(extractMetricFilters(undefined)).toEqual([])
  })
})

describe('topLevel operator', () => {
  it('creates topLevel filter for page column', () => {
    const f = topLevel(page)
    expect(f._filters[0]).toEqual({
      dimension: 'page',
      operator: 'topLevel',
      expression: '',
    })
  })

  it('topLevel filter excluded from GSC API body', () => {
    const body = gsc
      .select(page, clicks, impressions)
      .where(and(
        between(date, '2024-01-01', '2024-01-31'),
        topLevel(page),
      ))
      .toBody()

    expect(body.dimensionFilterGroups).toBeUndefined()
  })

  it('topLevel filter preserved in state', () => {
    const state = gsc
      .select(page, clicks, impressions)
      .where(and(
        between(date, '2024-01-01', '2024-01-31'),
        topLevel(page),
      ))
      .getState()

    const specialFilters = extractSpecialOperatorFilters(state.filter)
    expect(specialFilters).toHaveLength(1)
    expect(specialFilters[0].operator).toBe('topLevel')
  })
})

describe('full query examples from plan', () => {
  it('pages list query', () => {
    const state = gsc
      .select(page, clicks, impressions, ctr, position)
      .where(and(between(date, '2025-01-01', '2025-01-31'), contains(page, 'blog')))
      .orderBy(clicks, 'desc')
      .limit(100)
      .getState()

    expect(state.dimensions).toEqual(['page'])
    expect(state.metrics).toEqual(['clicks', 'impressions', 'ctr', 'position'])
    expect(state.orderBy).toEqual({ column: 'clicks', dir: 'desc' })
    expect(state.rowLimit).toBe(100)
  })

  it('striking distance query', () => {
    const state = gsc
      .select(query, clicks, impressions, ctr, position)
      .where(and(
        between(date, '2025-01-01', '2025-01-31'),
        gte(impressions, 100),
        gte(position, 4),
        lte(position, 20),
        lte(ctr, 0.05),
      ))
      .orderBy(impressions, 'desc')
      .limit(500)
      .getState()

    expect(state.dimensions).toEqual(['query'])
    expect(state.metrics).toEqual(['clicks', 'impressions', 'ctr', 'position'])
    expect(state.orderBy).toEqual({ column: 'impressions', dir: 'desc' })
    expect(state.rowLimit).toBe(500)

    const metricFilters = extractMetricFilters(state.filter)
    expect(metricFilters).toHaveLength(4)
  })

  it('site-wide analytics query', () => {
    const state = gsc
      .select(date, clicks, impressions, ctr, position)
      .where(between(date, '2025-01-01', '2025-01-31'))
      .getState()

    expect(state.dimensions).toEqual(['date'])
    expect(state.metrics).toEqual(['clicks', 'impressions', 'ctr', 'position'])
  })

  it('top-level pages only', () => {
    const state = gsc
      .select(page, clicks, impressions, ctr, position)
      .where(and(between(date, '2025-01-01', '2025-01-31'), topLevel(page)))
      .orderBy(clicks, 'desc')
      .limit(100)
      .getState()

    expect(state.dimensions).toEqual(['page'])
    const special = extractSpecialOperatorFilters(state.filter)
    expect(special).toHaveLength(1)
    expect(special[0].operator).toBe('topLevel')
  })

  it('keywords grouped by canonical form', () => {
    const state = gsc
      .select(queryCanonical, clicks, impressions, ctr, position)
      .where(between(date, '2025-01-01', '2025-01-31'))
      .orderBy(clicks, 'desc')
      .limit(100)
      .getState()

    expect(state.dimensions).toEqual(['queryCanonical'])
    expect(state.metrics).toEqual(['clicks', 'impressions', 'ctr', 'position'])
  })
})
