import { describe, expect, it } from 'vitest'
import { paginateSortedInMemory } from '../src/analyzer/paginate'

describe('paginateSortedInMemory', () => {
  it('matches a stable full sort for bounded and deep pages', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: index,
      score: (index * 37) % 11,
    }))
    const original = rows.slice()
    const compare = (left: { score: number }, right: { score: number }): number => right.score - left.score

    for (const input of [{ limit: 7 }, { offset: 19, limit: 13 }, { offset: 180, limit: 30 }]) {
      const expected = rows.slice().sort(compare).slice(input.offset ?? 0, (input.offset ?? 0) + input.limit)
      expect(paginateSortedInMemory(rows, input, compare)).toEqual(expected)
    }
    expect(rows).toEqual(original)
  })

  it('falls back to native sorting for non-finite comparisons', () => {
    const rows = [5, Number.NaN, 4, 3, 2, 1, 0, -1]
    const compare = (left: number, right: number): number => right - left
    expect(paginateSortedInMemory(rows, { limit: 3 }, compare))
      .toEqual(rows.slice().sort(compare).slice(0, 3))
  })
})
