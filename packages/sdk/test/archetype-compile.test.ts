import type { BuilderState, Filter } from 'gscdump/query'
import { and, between, country, date, eq, gsc, impressions, ne, or, page, query } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { archetypeSeamSupportsQuery, builderStateToArchetype, extractWireDateRange } from '../src/archetype-compile'

const RANGE = { start: '2026-06-01', end: '2026-06-30' }
const builtDateFilter = between(date, RANGE.start, RANGE.end)

function stateFor(build: (b: typeof gsc) => { getState: () => BuilderState }): BuilderState {
  return build(gsc).getState()
}

describe('builderStateToArchetype', () => {
  it('compiles dimensions:[date] with no entity filter to site-daily-timeseries', () => {
    const state = stateFor(b => b.select('date').where(builtDateFilter))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({
      archetype: 'site-daily-timeseries',
      siteId: 'site-1',
      range: RANGE,
      searchType: 'web',
    })
  })

  it('compiles dimensions:[date] + page equality to entity-daily-timeseries', () => {
    const state = stateFor(b => b.select('date').where(and(builtDateFilter, eq(page, '/blog'))))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({
      archetype: 'entity-daily-timeseries',
      entity: { dimension: 'page', value: '/blog' },
    })
  })

  it('compiles dimensions:[date] + query equality to entity-daily-timeseries', () => {
    const state = stateFor(b => b.select('date').where(and(builtDateFilter, eq(query, 'nuxt seo'))))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({
      archetype: 'entity-daily-timeseries',
      entity: { dimension: 'query', value: 'nuxt seo' },
    })
  })

  it('declines dimensions:[date] + an unrelated (country) filter — buildSiteDailyTimeseries applies no facets and would silently drop it', () => {
    const state = stateFor(b => b.select('date').where(and(builtDateFilter, eq(country, 'US'))))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('declines dimensions:[date] with BOTH page and query pinned — entity is single-dimension', () => {
    const state = stateFor(b => b.select('date').where(and(builtDateFilter, eq(page, '/blog'), eq(query, 'x'))))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('compiles dimensions:[date, device] to multi-series-stacked-daily', () => {
    const state = stateFor(b => b.select('date', 'device').where(builtDateFilter))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({ archetype: 'multi-series-stacked-daily', seriesDimension: 'device' })
  })

  it('declines dimensions:[date, device] with an extra equality filter — no facet support in that SQL builder', () => {
    const state = stateFor(b => b.select('date', 'device').where(and(builtDateFilter, eq(country, 'US'))))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('compiles a single non-date dimension to top-n-breakdown with no facets', () => {
    const state = stateFor(b => b.select('query').where(builtDateFilter).limit(25))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({ archetype: 'top-n-breakdown', dimension: 'query', limit: 25 })
    expect((result as any).facets).toBeUndefined()
  })

  it('threads an extra equality filter into top-n-breakdown as a facet (e.g. top queries for one page)', () => {
    const state = stateFor(b => b.select('query').where(and(builtDateFilter, eq(page, '/blog'))))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({
      archetype: 'top-n-breakdown',
      dimension: 'query',
      facets: [{ column: 'page', op: 'eq', value: '/blog' }],
    })
  })

  it('declines a top-n-breakdown whose own group dimension is ALSO pinned — ambiguous, single-row-lookup territory', () => {
    const state = stateFor(b => b.select('query').where(and(builtDateFilter, eq(query, 'x'))))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('threads orderBy + offset into top-n-breakdown', () => {
    const state = stateFor(b => b.select('page').where(builtDateFilter).orderBy(impressions, 'asc').limit(10).offset(20))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({ orderBy: { metric: 'impressions', dir: 'asc' }, limit: 10, offset: 20 })
  })

  it('compiles dimensions:[page, query] to two-dimension-detail', () => {
    const state = stateFor(b => b.select('page', 'query').where(builtDateFilter))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({ archetype: 'two-dimension-detail' })
  })

  it('compiles dimensions:[query, page] (reverse order) to two-dimension-detail too', () => {
    const state = stateFor(b => b.select('query', 'page').where(builtDateFilter))
    const result = builderStateToArchetype('site-1', state)
    expect(result).toMatchObject({ archetype: 'two-dimension-detail' })
  })

  it('declines dimensions:[country, device] — buildTwoDimensionDetail is hardcoded to (url, query)', () => {
    const state = stateFor(b => b.select('country', 'device').where(builtDateFilter))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('declines two-dimension-detail with an extra facet — its `filter` only takes page/query values', () => {
    const state = stateFor(b => b.select('page', 'query').where(and(builtDateFilter, eq(country, 'US'))))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('declines zero dimensions', () => {
    const state = stateFor(b => b.select().where(builtDateFilter))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('declines three or more dimensions', () => {
    const state = stateFor(b => b.select('page', 'query', 'country').where(builtDateFilter))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('declines a filter with no resolvable date range', () => {
    const state = stateFor(b => b.select('date').where(eq(page, '/blog')))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('declines an OR group — not representable as a flat equality facet list', () => {
    const state = stateFor(b => b.select('query').where(and(builtDateFilter, or(eq(page, '/a'), eq(page, '/b')))))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('declines a non-equality predicate (ne) on a dimension', () => {
    const state = stateFor(b => b.select('query').where(and(builtDateFilter, ne(page, '/blog'))))
    expect(builderStateToArchetype('site-1', state)).toBeNull()
  })

  it('declines dimensions:[hour] and dimensions:[searchAppearance] — no archetype SQL builder groups by these', () => {
    const hourState = stateFor(b => b.select('hour').where(builtDateFilter))
    const saState = stateFor(b => b.select('searchAppearance').where(builtDateFilter))
    expect(builderStateToArchetype('site-1', hourState)).toBeNull()
    expect(builderStateToArchetype('site-1', saState)).toBeNull()
  })

  it('threads searchType and compareRange options through unchanged', () => {
    const state = stateFor(b => b.select('date').where(builtDateFilter))
    const result = builderStateToArchetype('site-1', state, {
      searchType: 'discover',
      compareRange: { start: '2026-05-01', end: '2026-05-30' },
    })
    expect(result).toMatchObject({
      searchType: 'discover',
      compareRange: { start: '2026-05-01', end: '2026-05-30' },
    })
  })
})

// Input tolerance ported from nuxtseo's client-side compiler: the pro-gsc
// layer passes partner wire-format filter trees (`{ type: 'and', filters }`
// groups with `{ type: 'eq', column, value }` leaves) rather than SDK-branded
// `_filters` trees. Both must compile identically.
describe('builderStateToArchetype — wire-format filter trees', () => {
  const wireDates = { type: 'between', column: 'date', from: RANGE.start, to: RANGE.end }

  function wireEq(column: string, value: string) {
    return { type: 'eq', column, value }
  }

  function wireAnd(...filters: unknown[]) {
    return { type: 'and', filters }
  }

  function wireState(state: Omit<BuilderState, 'filter'> & { filter: unknown }): BuilderState {
    return state as BuilderState
  }

  it('date series with a wire query pin compiles to entity-daily-timeseries', () => {
    const q = builderStateToArchetype('s_1', wireState({
      dimensions: ['date'],
      filter: wireAnd(wireDates, wireEq('query', 'sitemap validator')),
    }))
    expect(q).toMatchObject({ archetype: 'entity-daily-timeseries', entity: { dimension: 'query', value: 'sitemap validator' } })
  })

  it('date series with a queryCanonical pin compiles to a canonical-entity daily timeseries (the keyword-group chart)', () => {
    expect(builderStateToArchetype('s_1', wireState({
      dimensions: ['date'],
      filter: wireAnd(wireDates, wireEq('queryCanonical', 'sitemap validator')),
    }))).toMatchObject({ archetype: 'entity-daily-timeseries', entity: { dimension: 'queryCanonical', value: 'sitemap validator' } })
  })

  it('date series with an inexpressible pin (country / device) returns null instead of the SITE-WIDE series', () => {
    for (const column of ['country', 'device']) {
      expect(builderStateToArchetype('s_1', wireState({
        dimensions: ['date'],
        filter: wireAnd(wireDates, wireEq(column, 'x')),
      }))).toBeNull()
    }
  })

  it('date series with a pin BESIDE the entity pin returns null (the extra filter would be dropped)', () => {
    expect(builderStateToArchetype('s_1', wireState({
      dimensions: ['date'],
      filter: wireAnd(wireDates, wireEq('query', 'sitemap validator'), wireEq('country', 'aus')),
    }))).toBeNull()
  })

  it('breakdown with a cross-dimension wire pin carries it as a facet', () => {
    const q = builderStateToArchetype('s_1', wireState({
      dimensions: ['query'],
      filter: wireAnd(wireDates, wireEq('queryCanonical', 'sitemap validator')),
      rowLimit: 12,
    }))
    expect(q).toMatchObject({
      archetype: 'top-n-breakdown',
      dimension: 'query',
      facets: [{ column: 'queryCanonical', op: 'eq', value: 'sitemap validator' }],
    })
  })

  it('breakdown pinning its OWN dimension returns null (ambiguous group-and-pin shape)', () => {
    expect(builderStateToArchetype('s_1', wireState({
      dimensions: ['query'],
      filter: wireAnd(wireDates, wireEq('query', 'sitemap validator')),
      rowLimit: 1,
    }))).toBeNull()
  })
})

describe('extractWireDateRange', () => {
  it('extracts the window from a wire-format filter', () => {
    expect(extractWireDateRange({ type: 'and', filters: [{ type: 'between', column: 'date', from: RANGE.start, to: RANGE.end }] })).toEqual(RANGE)
  })

  it('extracts the window from an SDK-branded filter', () => {
    const state = stateFor(b => b.select('date').where(builtDateFilter))
    expect(extractWireDateRange(state.filter as Filter<any>)).toEqual(RANGE)
  })

  it('returns null when no complete range is present', () => {
    expect(extractWireDateRange(undefined)).toBeNull()
    expect(extractWireDateRange({ type: 'and', filters: [{ type: 'eq', column: 'page', value: '/x' }] })).toBeNull()
  })
})

describe('archetypeSeamSupportsQuery', () => {
  it('declines two-dimension-detail — no offset/includeTotal in the contract yet', () => {
    const state = stateFor(b => b.select('page', 'query').where(builtDateFilter))
    const compiled = builderStateToArchetype('site-1', state)!
    expect(archetypeSeamSupportsQuery(compiled)).toBe(false)
  })

  it('supports site-daily-timeseries, entity-daily-timeseries, multi-series-stacked-daily, and top-n-breakdown', () => {
    const shapes: BuilderState[] = [
      stateFor(b => b.select('date').where(builtDateFilter)),
      stateFor(b => b.select('date').where(and(builtDateFilter, eq(page, '/blog')))),
      stateFor(b => b.select('date', 'device').where(builtDateFilter)),
      stateFor(b => b.select('query').where(builtDateFilter)),
    ]
    for (const state of shapes) {
      const compiled = builderStateToArchetype('site-1', state)!
      expect(compiled).not.toBeNull()
      expect(archetypeSeamSupportsQuery(compiled)).toBe(true)
    }
  })
})
