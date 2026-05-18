import { describe, expect, it } from 'vitest'
import { gsc } from '../../src/query/builder'
import { country, date, device, page } from '../../src/query/columns'
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

    it('builds body with inArray as OR group', () => {
      const body = gsc
        .select('country')
        .where(and(
          inArray(country, [Countries.USA, Countries.GBR, Countries.AUS]),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      // inArray creates an OR group that's preserved
      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].groupType).toBe('or')
      expect(body.dimensionFilterGroups![0].filters).toHaveLength(3)
    })

    it('builds body with nested or() preserved as OR group', () => {
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

      // Creates 2 groups: one AND for device, one OR for countries
      expect(body.dimensionFilterGroups).toHaveLength(2)
      // First group is AND with device filter
      expect(body.dimensionFilterGroups![0].groupType).toBeUndefined() // AND is default
      expect(body.dimensionFilterGroups![0].filters).toHaveLength(1)
      // Second group is OR with country filters
      expect(body.dimensionFilterGroups![1].groupType).toBe('or')
      expect(body.dimensionFilterGroups![1].filters).toHaveLength(2)
    })

    it('builds body with standalone or() as OR group', () => {
      const body = gsc
        .select('country')
        .where(and(
          or(
            eq(country, Countries.USA),
            eq(country, Countries.GBR),
          ),
          between(date, '2024-01-01', '2024-01-31'),
        ))
        .toBody()

      expect(body.dimensionFilterGroups).toHaveLength(1)
      expect(body.dimensionFilterGroups![0].groupType).toBe('or')
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
