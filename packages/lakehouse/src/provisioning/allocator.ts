/**
 * Team-scoped Catalog Site Id allocator (ADR-0021 amendment 11).
 *
 * A "Catalog Site Id" is the small INT32 join key every dataset's `'site-int'`
 * identity partitions on (nuxtseo ADR-0091's `gscdumpSiteIntId` / gscdump's
 * `user_sites.int_id`). One allocator, owned here, so no consumer hand-rolls
 * its own next-int sequence (the exact copy-paste class ADR-0021 exists to
 * close). Pure — the caller persists the result; this module has no DB.
 *
 * Two entry points into a team's id space:
 *  - ADOPT a `supplied` id (e.g. gscdump's existing `int_id` for a site that
 *    predates the allocator) — validated for TEAM-SCOPE uniqueness, never
 *    silently reassigned.
 *  - ALLOCATE fresh — next-int strictly above every existing id in the team
 *    (adopted ids included), so a later allocation can never collide with an
 *    earlier adoption.
 */

export type AllocateCatalogSiteIdResult
  = | { _tag: 'allocated', id: number }
    | { _tag: 'adopted', id: number }
    | { _tag: 'collision', id: number }

export interface AllocateCatalogSiteIdOptions {
  /** Every Catalog Site Id already in use for this team (adopted + previously allocated). */
  existingIds: Iterable<number>
  /**
   * Adopt this id instead of allocating a fresh one (e.g. gscdump's existing
   * `int_id`). Validated against `existingIds` for team-scope uniqueness —
   * a collision is returned as a value, never silently resolved.
   */
  supplied?: number
}

const INT32_MAX = 2_147_483_647

/**
 * Adopt `supplied`, or allocate the next unused int strictly above every id
 * already in `existingIds`. Never mutates the caller's set; never reuses an
 * id already present.
 */
export function allocateCatalogSiteId(opts: AllocateCatalogSiteIdOptions): AllocateCatalogSiteIdResult {
  const existing = new Set(opts.existingIds)

  if (opts.supplied != null) {
    if (existing.has(opts.supplied))
      return { _tag: 'collision', id: opts.supplied }
    return { _tag: 'adopted', id: opts.supplied }
  }

  let max = 0
  for (const id of existing) {
    if (id > max)
      max = id
  }
  let next = max + 1
  // Defensive — `max` already excludes duplicates (it's derived from a Set),
  // so this loop only ever runs once in practice; kept for a set with gaps
  // above `max` that a caller might have pre-reserved.
  while (existing.has(next)) next++
  if (next > INT32_MAX)
    throw new RangeError(`allocateCatalogSiteId: exhausted the INT32 id space (next=${next})`)
  return { _tag: 'allocated', id: next }
}
