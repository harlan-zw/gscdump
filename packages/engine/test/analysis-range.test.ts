import { describe, expect, it } from 'vitest'
import { analysisRequestedRange } from '../src/analysis-range'

describe('analysisRequestedRange', () => {
  it('merges current, comparison, and builder-state date bounds', () => {
    expect(analysisRequestedRange({
      type: 'data-query',
      startDate: '2026-05-10',
      endDate: '2026-05-12',
      prevStartDate: '2026-05-01',
      prevEndDate: '2026-05-09',
      q: {
        dimensions: ['page'],
        filter: { type: 'between', column: 'date', from: '2026-04-20', to: '2026-04-21' },
      },
    } as never)).toEqual({ start: '2026-04-20', end: '2026-05-12' })
  })

  it('ignores invalid direct ranges', () => {
    expect(analysisRequestedRange({
      type: 'data-query',
      startDate: '2026-06-01',
      endDate: '2026-05-01',
    } as never)).toBeNull()
  })

  it('propagates malformed filters unless the host handles the parse failure', () => {
    const params = {
      q: {
        filter: new Proxy({}, {
          has: () => {
            throw new Error('unreadable filter')
          },
        }),
      },
    } as never

    expect(() => analysisRequestedRange(params)).toThrow('unreadable filter')
    const errors: unknown[] = []
    expect(analysisRequestedRange(params, error => errors.push(error))).toBeNull()
    expect(errors).toHaveLength(1)
  })
})
