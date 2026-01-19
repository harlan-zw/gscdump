import type { GSCRow } from '../../src/query'
import { describe, expectTypeOf, it } from 'vitest'
import { and, between, contains, country, Country, date, device, Device, eq, gsc, inArray, page } from '../../src/query'

describe('type inference', () => {
  describe('eq narrowing', () => {
    it('narrows device type with eq', () => {
      const builder = gsc
        .select('device')
        .where(eq(device, Device.MOBILE))
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      // Device should be narrowed to 'MOBILE'
      expectTypeOf<ResultRow['device']>().toEqualTypeOf<'MOBILE'>()
    })

    it('narrows country type with eq', () => {
      const builder = gsc
        .select('country')
        .where(eq(country, Country.USA))
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      // Country should be narrowed to 'usa'
      expectTypeOf<ResultRow['country']>().toEqualTypeOf<'usa'>()
    })
  })

  describe('inArray narrowing', () => {
    it('narrows country to union with inArray', () => {
      const builder = gsc
        .select('country')
        .where(inArray(country, [Country.USA, Country.GBR] as const))
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      // Country should be narrowed to 'usa' | 'gbr'
      expectTypeOf<ResultRow['country']>().toEqualTypeOf<'usa' | 'gbr'>()
    })

    it('narrows device to union with inArray', () => {
      const builder = gsc
        .select('device')
        .where(inArray(device, [Device.MOBILE, Device.TABLET] as const))
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      expectTypeOf<ResultRow['device']>().toEqualTypeOf<'MOBILE' | 'TABLET'>()
    })
  })

  describe('and merging', () => {
    it('merges constraints with and', () => {
      const builder = gsc
        .select('device', 'country')
        .where(and(
          eq(device, Device.MOBILE),
          eq(country, Country.GBR),
        ))
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      expectTypeOf<ResultRow['device']>().toEqualTypeOf<'MOBILE'>()
      expectTypeOf<ResultRow['country']>().toEqualTypeOf<'gbr'>()
    })

    it('merges eq and inArray constraints', () => {
      const builder = gsc
        .select('device', 'country')
        .where(and(
          eq(device, Device.DESKTOP),
          inArray(country, [Country.USA, Country.CAN] as const),
        ))
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      expectTypeOf<ResultRow['device']>().toEqualTypeOf<'DESKTOP'>()
      expectTypeOf<ResultRow['country']>().toEqualTypeOf<'usa' | 'can'>()
    })
  })

  describe('non-narrowing operators', () => {
    it('contains does not narrow type', () => {
      const builder = gsc
        .select('page')
        .where(contains(page, '/blog/'))
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      // Page should remain string
      expectTypeOf<ResultRow['page']>().toEqualTypeOf<string>()
    })

    it('mixed narrowing and non-narrowing', () => {
      const builder = gsc
        .select('page', 'device')
        .where(and(
          eq(device, Device.MOBILE),
          contains(page, '/blog/'),
        ))
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      // Device should be narrowed
      expectTypeOf<ResultRow['device']>().toEqualTypeOf<'MOBILE'>()
      // Page should remain string (contains doesn't narrow)
      expectTypeOf<ResultRow['page']>().toEqualTypeOf<string>()
    })
  })

  describe('base row types', () => {
    it('includes metrics in row', () => {
      const builder = gsc
        .select('page')
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      expectTypeOf<ResultRow['clicks']>().toEqualTypeOf<number>()
      expectTypeOf<ResultRow['impressions']>().toEqualTypeOf<number>()
      expectTypeOf<ResultRow['ctr']>().toEqualTypeOf<number>()
      expectTypeOf<ResultRow['position']>().toEqualTypeOf<number>()
    })

    it('includes selected dimensions', () => {
      const builder = gsc
        .select('page', 'query', 'device')
        .where(between(date, '2024-01-01', '2024-01-31'))

      type ResultRow = Awaited<ReturnType<typeof builder.execute>>['rows'][number]

      expectTypeOf<ResultRow['page']>().toEqualTypeOf<string>()
      expectTypeOf<ResultRow['query']>().toEqualTypeOf<string>()
      expectTypeOf<ResultRow['device']>().toEqualTypeOf<Device>()
    })
  })

  describe('GSCRow type helper', () => {
    it('creates correct row type with narrowing', () => {
      type MyRow = GSCRow<['page', 'device'], { device: 'MOBILE' }>

      expectTypeOf<MyRow['page']>().toEqualTypeOf<string>()
      expectTypeOf<MyRow['device']>().toEqualTypeOf<'MOBILE'>()
      expectTypeOf<MyRow['clicks']>().toEqualTypeOf<number>()
    })
  })
})
