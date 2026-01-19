import { describe, expect, it } from 'vitest'
import { country, device, page, query } from '../../src/query/columns'
import { Country, Device } from '../../src/query/constants'
import { and, contains, eq, inArray, like, ne, not, notRegex, or, regex } from '../../src/query/operators'

describe('operators', () => {
  describe('eq', () => {
    it('creates equals filter for device', () => {
      const f = eq(device, Device.MOBILE)
      expect(f._filters[0]).toEqual({
        dimension: 'device',
        operator: 'equals',
        expression: 'MOBILE',
      })
    })

    it('creates equals filter for country', () => {
      const f = eq(country, Country.USA)
      expect(f._filters[0]).toEqual({
        dimension: 'country',
        operator: 'equals',
        expression: 'usa',
      })
    })

    it('creates equals filter for page', () => {
      const f = eq(page, '/blog/test')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'equals',
        expression: '/blog/test',
      })
    })
  })

  describe('ne', () => {
    it('creates notEquals filter', () => {
      const f = ne(device, Device.TABLET)
      expect(f._filters[0]).toEqual({
        dimension: 'device',
        operator: 'notEquals',
        expression: 'TABLET',
      })
    })
  })

  describe('inArray', () => {
    it('creates OR group for multiple values', () => {
      const f = inArray(country, [Country.USA, Country.GBR])
      expect(f._filters).toHaveLength(2)
      expect(f._groupType).toBe('or')
      expect(f._filters[0]).toEqual({
        dimension: 'country',
        operator: 'equals',
        expression: 'usa',
      })
      expect(f._filters[1]).toEqual({
        dimension: 'country',
        operator: 'equals',
        expression: 'gbr',
      })
    })

    it('works with devices', () => {
      const f = inArray(device, [Device.MOBILE, Device.DESKTOP])
      expect(f._filters).toHaveLength(2)
      expect(f._groupType).toBe('or')
    })
  })

  describe('contains', () => {
    it('creates contains filter', () => {
      const f = contains(page, '/blog/')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'contains',
        expression: '/blog/',
      })
    })
  })

  describe('like', () => {
    it('converts SQL LIKE to contains', () => {
      const f = like(page, '%/blog/%')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'contains',
        expression: '/blog/',
      })
    })

    it('handles patterns without %', () => {
      const f = like(query, 'test')
      expect(f._filters[0].expression).toBe('test')
    })
  })

  describe('regex', () => {
    it('creates includingRegex filter from string', () => {
      const f = regex(page, '^/blog/2024')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'includingRegex',
        expression: '^/blog/2024',
      })
    })

    it('creates includingRegex filter from RegExp', () => {
      const f = regex(page, /^\/blog\/\d+/)
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'includingRegex',
        expression: '^\\/blog\\/\\d+',
      })
    })
  })

  describe('notRegex', () => {
    it('creates excludingRegex filter', () => {
      const f = notRegex(page, '^/admin')
      expect(f._filters[0]).toEqual({
        dimension: 'page',
        operator: 'excludingRegex',
        expression: '^/admin',
      })
    })
  })

  describe('and', () => {
    it('merges filters from multiple filters', () => {
      const f = and(
        eq(device, Device.MOBILE),
        eq(country, Country.USA),
      )
      expect(f._filters).toHaveLength(2)
      expect(f._groupType).toBe('and')
    })

    it('handles nested filters', () => {
      const f = and(
        eq(device, Device.MOBILE),
        contains(page, '/blog/'),
        eq(country, Country.GBR),
      )
      expect(f._filters).toHaveLength(3)
    })
  })

  describe('or', () => {
    it('creates OR group', () => {
      const f = or(
        eq(device, Device.MOBILE),
        eq(device, Device.TABLET),
      )
      expect(f._filters).toHaveLength(2)
      expect(f._groupType).toBe('or')
    })
  })

  describe('not', () => {
    it('inverts equals to notEquals', () => {
      const original = eq(device, Device.MOBILE)
      const inverted = not(original)
      expect(inverted._filters[0].operator).toBe('notEquals')
    })

    it('inverts contains to notContains', () => {
      const original = contains(page, '/blog/')
      const inverted = not(original)
      expect(inverted._filters[0].operator).toBe('notContains')
    })

    it('inverts includingRegex to excludingRegex', () => {
      const original = regex(page, '^/blog')
      const inverted = not(original)
      expect(inverted._filters[0].operator).toBe('excludingRegex')
    })

    it('double negation restores original operator', () => {
      const original = eq(device, Device.MOBILE)
      const doubleInverted = not(not(original))
      expect(doubleInverted._filters[0].operator).toBe('equals')
    })
  })
})
