import { describe, expect, it } from 'vitest'
import { allocateCatalogSiteId } from '../src/provisioning/allocator'

describe('allocateCatalogSiteId', () => {
  it('allocates 1 for an empty team', () => {
    expect(allocateCatalogSiteId({ existingIds: [] })).toEqual({ _tag: 'allocated', id: 1 })
  })

  it('allocates strictly above the max existing id', () => {
    expect(allocateCatalogSiteId({ existingIds: [3, 7, 2] })).toEqual({ _tag: 'allocated', id: 8 })
  })

  it('adopts a supplied id not already in use', () => {
    expect(allocateCatalogSiteId({ existingIds: [1, 2], supplied: 48213 })).toEqual({ _tag: 'adopted', id: 48213 })
  })

  it('reports a collision when the supplied id is already in use', () => {
    expect(allocateCatalogSiteId({ existingIds: [1, 48213], supplied: 48213 })).toEqual({ _tag: 'collision', id: 48213 })
  })

  it('adopt-then-allocate never produces a duplicate (the load-bearing sequence)', () => {
    // Adopt gscdump's existing int_id 48213 for a pre-existing site.
    const adopted = allocateCatalogSiteId({ existingIds: [], supplied: 48213 })
    expect(adopted).toEqual({ _tag: 'adopted', id: 48213 })

    // Persist it, then allocate a FRESH id for a new site in the same team.
    const existingIds = [48213]
    const next = allocateCatalogSiteId({ existingIds })
    expect(next._tag).toBe('allocated')
    expect((next as { id: number }).id).not.toBe(48213)
    expect((next as { id: number }).id).toBeGreaterThan(48213)

    // A THIRD allocation must not collide with either prior id.
    existingIds.push((next as { id: number }).id)
    const third = allocateCatalogSiteId({ existingIds })
    expect(existingIds).not.toContain((third as { id: number }).id)
  })

  it('never mutates the caller-supplied existingIds iterable', () => {
    const existingIds = [1, 2, 3]
    allocateCatalogSiteId({ existingIds })
    expect(existingIds).toEqual([1, 2, 3])
  })

  it('fills a gap only when it sits above every other id (still strictly max+1 semantics)', () => {
    // Sparse ids: max is 10, so the next allocation is 11 regardless of gaps below it.
    expect(allocateCatalogSiteId({ existingIds: [1, 10, 4] })).toEqual({ _tag: 'allocated', id: 11 })
  })
})
