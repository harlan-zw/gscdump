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
    ['ytd', '2025-01-01', 59],
  ] as const)('resolves %s as an inclusive window', (preset, start, days) => {
    expect(resolveWindow({ preset, anchor: '2025-02-28' })).toEqual({
      start,
      end: '2025-02-28',
      days,
    })
  })

  it('resolves previous-period and 365-day comparison windows', () => {
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
      comparison: { start: '2023-02-01', end: '2023-03-01' },
    })
  })

  it('rejects a custom preset without both bounds', () => {
    expect(() => resolveWindow({ preset: 'custom', start: '2025-01-01' }))
      .toThrow('resolveWindow: preset=custom requires start and end')
  })
})
