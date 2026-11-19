import { describe, expect, it } from 'vitest'
import { gsc } from '../../src/query/builder'
import { brandedClassification, country, date, device, page, query as queryColumn } from '../../src/query/columns'
import { Countries, Devices } from '../../src/query/constants'
import { and, between, contains, eq, gt, gte, inArray, lt, lte, or, regex } from '../../src/query/operators'

describe('gSCQueryBuilder', () => {
  describe('toBody', () => {
    it('builds correct query body with dimensions and between()', () => {
      const body = gsc
        .select('page', 'device')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensions).toEqual(['page', 'device'])
      expect(body.startDate).toBe('2024-01-01')
      expect(body.endDate).toBe('2024-01-31')
    })

    it('builds correct query body with gte/lte using and()', () => {
      const body = gsc
        .select('page')
        .where(and(
          gte(date, '2024-01-01'),
          lte(date, '2024-01-31'),
        ))
        .toBody()

      expect(body.startDate).toBe('2024-01-01')
      expect(body.endDate).toBe('2024-01-31')
    })

    it('adjusts date for gt (adds 1 day)', () => {
      const body = gsc
        .select('page')
        .where(and(
          gt(date, '2024-01-01'),
          lte(date, '2024-01-31'),
        ))
        .toBody()

      expect(body.startDate).toBe('2024-01-02')
      expect(body.endDate).toBe('2024-01-31')
    })

    it('adjusts date for lt (subtracts 1 day)', () => {
      const body = gsc
        .select('page')
        .where(and(
          gte(date, '2024-01-01'),
          lt(date, '2024-02-01'),
        ))
        .toBody()

      expect(body.startDate).toBe('2024-01-01')
      expect(body.endDate).toBe('2024-01-31')
    })

    it('builds body with single eq filter and date', () => {
      const body = gsc
        .select('page', 'device')
        .where(and(
          eq(device, Devices.MOBILE),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensions).toEqual(['page', 'device'])
      expect(body.dimensionFilterGroups).toBeDefined()
      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].filters).toEqual([{
        dimension: 'device',
        operator: 'equals',
        expression: 'MOBILE',
      }])
    })

    it('builds body with multiple filters using and()', () => {
      const body = gsc
        .select('page', 'device', 'country')
        .where(and(
          eq(device, Devices.MOBILE),
          eq(country, Countries.USA),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].filters).toHaveLength(2)
    })

    it('sends country and device selections as exact match lists', () => {
      const body = gsc
        .select('country')
        .where(and(
          inArray(country, [Countries.USA, Countries.GBR, Countries.AUS]),
          inArray(device, [Devices.MOBILE, Devices.TABLET]),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensionFilterGroups).toEqual([
        { filters: [], filterLists: [{ dimension: 'country', expressions: ['usa', 'gbr', 'aus'] }] },
        { filters: [], filterLists: [{ dimension: 'device', expressions: ['MOBILE', 'TABLET'] }] },
      ])
    })

    it('keeps a device filter alongside a country list', () => {
      const body = gsc
        .select('country', 'device')
        .where(and(
          or(
            eq(country, Countries.USA),
            eq(country, Countries.GBR),
          ),
          eq(device, Devices.MOBILE),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensionFilterGroups).toEqual([
        { filters: [{ dimension: 'device', operator: 'equals', expression: 'MOBILE' }] },
        { filters: [], filterLists: [{ dimension: 'country', expressions: ['usa', 'gbr'] }] },
      ])
    })

    it('preserves OR groups spanning different dimensions', () => {
      const body = gsc
        .select('country')
        .where(and(
          or(
            eq(country, Countries.USA),
            eq(device, Devices.MOBILE),
          ),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].groupType).toBe('or')
    })

    it('rejects a country list combined with a single country filter', () => {
      const query = gsc.select('date').where(and(
        between(date, '2026-03-01', '2026-03-31'),
        inArray(country, [Countries.USA, Countries.GBR]),
        eq(country, Countries.USA),
      ))

      expect(() => query.toBody()).toThrow('cannot appear in both filters and filterLists')
    })

    it('groups and filters by Google brand classification', () => {
      const range = between(date, '2026-03-01', '2026-03-31')
      const body = gsc.select('brandedClassification')
        .where(and(range, eq(brandedClassification, 'BRANDED')))
        .toBody()

      expect(body.dimensions).toEqual(['brandedClassification'])
      expect(body.dimensionFilterGroups).toEqual([
        { filters: [{ dimension: 'brandedClassification', operator: 'equals', expression: 'BRANDED' }] },
      ])
    })

    it('rejects Google brand grouping with a query filter', () => {
      const query = gsc.select('brandedClassification').where(and(
        between(date, '2026-03-01', '2026-03-31'),
        eq(queryColumn, 'example'),
      ))

      expect(() => query.toBody()).toThrow('cannot be combined with a query filter')
    })

    it('sends web multimodal as its own search type', () => {
      const body = gsc.select('date')
        .where(between(date, '2026-03-01', '2026-03-31'))
        .type('webMultimodal')
        .toBody()

      expect(body.type).toBe('webMultimodal')
    })

    it.each(['webMultimodal', 'discover', 'googleNews'] as const)('rejects brand grouping and filters for %s', (type) => {
      const range = between(date, '2026-10-01', '2026-10-31')
      expect(() => gsc.select('brandedClassification').where(range).type(type).toBody()).toThrow('Use Web, Image, Video, or News')
      const filtered = gsc.select('date').where(and(range, eq(brandedClassification, 'BRANDED'))).type(type)
      expect(() => filtered.toBody()).toThrow('Use Web, Image, Video, or News')
    })

    it('rejects query grouping and filters for Web Multimodal', () => {
      const range = between(date, '2026-10-01', '2026-10-31')
      expect(() => gsc.select('query').where(range).type('webMultimodal').toBody()).toThrow('remove the query dimension or filter')
      const filtered = gsc.select('date').where(and(range, eq(queryColumn, 'example'))).type('webMultimodal')
      expect(() => filtered.toBody()).toThrow('remove the query dimension or filter')
    })

    it('builds body with contains filter', () => {
      const body = gsc
        .select('page')
        .where(and(
          contains(page, '/blog/'),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensionFilterGroups![0].filters![0]).toEqual({
        dimension: 'page',
        operator: 'contains',
        expression: '/blog/',
      })
    })

    it('builds body with regex filter', () => {
      const body = gsc
        .select('page')
        .where(and(
          regex(page, '^/blog/2024'),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensionFilterGroups![0].filters![0]).toEqual({
        dimension: 'page',
        operator: 'includingRegex',
        expression: '^/blog/2024',
      })
    })

    it('sets rowLimit', () => {
      const body = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .limit(100)
        .toBody()

      expect(body.rowLimit).toBe(100)
    })

    it('sets startRow with offset', () => {
      const body = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .offset(50)
        .toBody()

      expect(body.startRow).toBe(50)
    })

    it('sets both rowLimit and startRow for pagination', () => {
      const body = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .limit(10)
        .offset(20)
        .toBody()

      expect(body.rowLimit).toBe(10)
      expect(body.startRow).toBe(20)
    })

    it('does not include dimensionFilterGroups when only date filter', () => {
      const body = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.dimensionFilterGroups).toBeUndefined()
    })

    it('throws when no date range set', () => {
      expect(() => gsc.select('page').toBody()).toThrow('Date range required')
    })

    it('emits wire field `type` (not deprecated `searchType`) when search type is filtered', async () => {
      const { searchType } = await import('../../src/query/columns')
      const body = gsc
        .select('page')
        .where(and(
          between(date, '2024-01-01', '2024-01-31'),
          eq(searchType, 'discover'),
        ))
        .toBody() as Record<string, unknown>

      expect(body.type).toBe('discover')
      expect(body.searchType).toBeUndefined()
    })

    it('emits aggregationType when set', () => {
      const body = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .aggregationType('byPage')
        .toBody()

      expect(body.aggregationType).toBe('byPage')
    })

    it('omits aggregationType when not set', () => {
      const body = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))
        .toBody()

      expect(body.aggregationType).toBeUndefined()
    })
  })

  describe('chaining', () => {
    it('combines multiple filters with and()', () => {
      const body = gsc
        .select('page', 'device')
        .where(and(
          eq(device, Devices.MOBILE),
          contains(page, '/blog/'),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].filters).toHaveLength(2)
    })

    it('allows chaining in any order', () => {
      const body = gsc
        .limit(50)
        .select('page', 'query')
        .where(and(
          between(date, '2024-01-01', '2024-01-31'),
          eq(device, Devices.DESKTOP),
        ))
        .toBody()

      expect(body.dimensions).toEqual(['page', 'query'])
      expect(body.rowLimit).toBe(50)
      expect(body.dimensionFilterGroups).toBeDefined()
    })
  })
})
