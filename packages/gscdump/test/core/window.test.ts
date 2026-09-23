import { describe, expect, it } from 'vitest'
import { resolveWindow } from '../../src/dates'

describe('resolveWindow', () => {
  it.each([
    ['last-7d', '2025-02-22', 7],
    ['last-28d', '2025-02-01', 28],
    ['last-30d', '2025-01-30', 30],
    ['last-90d', '2024-12-01', 90],
    ['last-180d', '2024-09-02', 180],
    ['last-365d', '2024-03-01', 365],
    ['mtd', '2025-02-01', 28],
    ['qtd', '2025-01-01', 59],
    ['ytd', '2025-01-01', 59],
  ] as const)('resolves %s as an inclusive window', (preset, start, days) => {
    expect(resolveWindow({ preset, anchor: '2025-02-28' })).toEqual({
      start,
      end: '2025-02-28',
      days,
    })
  })

  it.each([
    ['2025-02-28', '2024-10-01', '2024-12-31'],
    ['2025-03-31', '2025-01-01', '2025-03-31'],
    ['2025-01-01', '2024-10-01', '2024-12-31'],
  ])('resolves last-quarter at anchor %s to the newest complete quarter', (anchor, start, end) => {
    expect(resolveWindow({ preset: 'last-quarter', anchor })).toMatchObject({ start, end })
  })

  it('ends on the anchor, never on the wall clock', () => {
    expect(resolveWindow({ preset: 'last-7d', anchor: '2020-06-10' })).toEqual({ start: '2020-06-04', end: '2020-06-10', days: 7 })
  })

  it('rejects a preset without an anchor', () => {
    expect(() => resolveWindow({ preset: 'last-7d' } as never))
      .toThrow('resolveWindow: preset=last-7d requires an anchor date')
  })

  it('resolves previous-period and weekday-aligned year-over-year windows', () => {
    expect(resolveWindow({
      preset: 'custom',
      start: '2024-02-01',
      end: '2024-02-29',
      comparison: 'prev-period',
    })).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
      days: 29,
      comparison: { start: '2024-01-03', end: '2024-01-31' },
    })

    expect(resolveWindow({
      preset: 'custom',
      start: '2024-02-01',
      end: '2024-02-29',
      comparison: 'yoy',
    })).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
      days: 29,
      // 364 days back: 2024-02-01 (Thu) compares with 2023-02-02 (Thu).
      comparison: { start: '2023-02-02', end: '2023-03-02' },
    })
  })

  it('rejects a custom preset without both bounds', () => {
    expect(() => resolveWindow({ preset: 'custom', start: '2025-01-01' } as never))
      .toThrow('resolveWindow: preset=custom requires start and end')
  })
})
