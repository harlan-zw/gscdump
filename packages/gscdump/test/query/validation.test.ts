import { describe, expect, it } from 'vitest'
import { gsc } from '../../src/query/builder'
import { date, hour, page } from '../../src/query/columns'
import { between } from '../../src/query/operators'

describe('resolveToBody validation', () => {
  const dateRange = between(date, '2026-05-01', '2026-05-07')

  it('rejects non-positive rowLimit', () => {
    expect(() => gsc.select(page).where(dateRange).limit(0).toBody()).toThrow(/rowLimit/)
    expect(() => gsc.select(page).where(dateRange).limit(-5).toBody()).toThrow(/rowLimit/)
    expect(() => gsc.select(page).where(dateRange).limit(1.5).toBody()).toThrow(/rowLimit/)
  })

  it('allows rowLimit above 25k (pagination caps per-page)', () => {
    const body = gsc.select(page).where(dateRange).limit(100_000).toBody()
    expect(body.rowLimit).toBe(100_000)
  })

  it('rejects negative startRow', () => {
    expect(() => gsc.select(page).where(dateRange).offset(-1).toBody()).toThrow(/startRow/)
  })

  it('omits startRow when zero', () => {
    const body = gsc.select(page).where(dateRange).offset(0).toBody()
    expect(body.startRow).toBeUndefined()
  })

  describe('hour ↔ hourly_all', () => {
    it('requires dataState=hourly_all when grouping by hour', () => {
      expect(() => gsc.select(hour).where(dateRange).toBody()).toThrow(/hourly_all/)
    })

    it('rejects hourly_all without hour grouping', () => {
      expect(() => gsc.select(page).where(dateRange).dataState('hourly_all').toBody()).toThrow(/hour dimension/)
    })

    it('accepts the matched pair', () => {
      const body = gsc.select(hour).where(dateRange).dataState('hourly_all').toBody()
      expect(body.dataState).toBe('hourly_all')
    })
  })

  describe('aggregationType', () => {
    it('rejects byNewsShowcasePanel without discover/googleNews type', () => {
      expect(() =>
        gsc.select(page).where(dateRange).aggregationType('byNewsShowcasePanel').toBody(),
      ).toThrow(/byNewsShowcasePanel/)
    })

    it('accepts byNewsShowcasePanel with type discover', () => {
      const body = gsc.select(page).where(dateRange).type('discover').aggregationType('byNewsShowcasePanel').toBody()
      expect(body.aggregationType).toBe('byNewsShowcasePanel')
      expect(body.type).toBe('discover')
    })

    it('rejects byProperty for discover/googleNews', () => {
      expect(() =>
        gsc.select(page).where(dateRange).type('googleNews').aggregationType('byProperty').toBody(),
      ).toThrow(/byProperty/)
    })
  })
})

describe('builder .type()', () => {
  const dateRange = between(date, '2026-05-01', '2026-05-07')

  it('sets body.type', () => {
    const body = gsc.select(page).where(dateRange).type('image').toBody()
    expect(body.type).toBe('image')
  })

  it('overrides searchType filter when both set', () => {
    // Using state directly since the filter form is internal.
    const state = gsc.select(page).where(dateRange).type('news').getState()
    expect(state.searchType).toBe('news')
  })
})
