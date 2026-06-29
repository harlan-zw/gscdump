/**
 * Unit tests for the manifest-list partition pruner. The predicate is an
 * inclusive projection: it returns `false` (skip the manifest) ONLY when the
 * manifest's partition summaries prove it cannot hold the target slice, and
 * `true` (keep) on any uncertainty — so it must never drop a matching manifest.
 */

import type { IcebergFieldSummary } from '../src/iceberg/partition-prune'
import { describe, expect, it } from 'vitest'
import { buildPartitionFilter } from '../src/iceberg/partition-prune'

/** identity(site_id) / identity(search_type) bounds are UTF-8 string bytes. */
function strBound(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** month(date)=date_month bounds are 4-byte little-endian int32. */
function intBound(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setInt32(0, n, true)
  return b
}

function summary(lower?: Uint8Array, upper?: Uint8Array): IcebergFieldSummary {
  return { contains_null: false, lower_bound: lower ?? null, upper_bound: upper ?? null }
}

/**
 * Build the `[site_id, search_type, date_month]` summary tuple (spec order).
 * `searchType` defaults to an empty summary, so most tests exercise the
 * site/month dimensions without the search_type clause pruning.
 */
function parts(
  site: IcebergFieldSummary,
  month: IcebergFieldSummary,
  searchType: IcebergFieldSummary = summary(),
): IcebergFieldSummary[] {
  return [site, searchType, month]
}

const MONTHS = new Set([676]) // 2026-05

function stringFilter(siteId: string | number, searchType: string | number, months: ReadonlySet<number>) {
  return buildPartitionFilter(siteId, searchType, months, 'string')
}

describe('buildPartitionFilter', () => {
  it('keeps a manifest with no summaries (cannot prune)', () => {
    const f = stringFilter('s3', 'web', MONTHS)
    expect(f(undefined)).toBe(true)
    expect(f([])).toBe(true)
  })

  it('keeps when the target site is inside the summary range', () => {
    const f = stringFilter('s3', 'web', MONTHS)
    const p = parts(summary(strBound('s1'), strBound('s5')), summary(intBound(670), intBound(680)))
    expect(f(p)).toBe(true)
  })

  it('coerces numeric keys before string-encoded lexicographic pruning', () => {
    const f = buildPartitionFilter(2, 2, MONTHS, 'string')
    const p = parts(
      summary(strBound('10'), strBound('2')),
      summary(intBound(676), intBound(676)),
      summary(strBound('10'), strBound('2')),
    )
    expect(f(p)).toBe(true)
  })

  it('defaults to int encoding and avoids string-bound pruning on identity columns', () => {
    const f = buildPartitionFilter('s9', 'discover', MONTHS)
    const p = parts(
      summary(strBound('s1'), strBound('s5')),
      summary(intBound(676), intBound(676)),
      summary(strBound('web'), strBound('web')),
    )
    // Under int encoding these identity bounds are int bytes, not UTF-8. The
    // default path keeps the manifest instead of decoding string garbage.
    expect(f(p)).toBe(true)
  })

  it('skips when the target site is above the range', () => {
    const f = stringFilter('s9', 'web', MONTHS)
    const p = parts(summary(strBound('s1'), strBound('s5')), summary(intBound(670), intBound(680)))
    expect(f(p)).toBe(false)
  })

  it('skips when the target site is below the range', () => {
    const f = stringFilter('s0', 'web', MONTHS)
    const p = parts(summary(strBound('s1'), strBound('s5')), summary(intBound(670), intBound(680)))
    expect(f(p)).toBe(false)
  })

  it('skips when no wanted month overlaps the date_month range', () => {
    const f = stringFilter('s3', 'web', MONTHS)
    const p = parts(summary(strBound('s1'), strBound('s5')), summary(intBound(600), intBound(650)))
    expect(f(p)).toBe(false)
  })

  it('keeps when at least one wanted month overlaps', () => {
    const f = stringFilter('s3', 'web', new Set([650, 676, 700]))
    const p = parts(summary(strBound('s1'), strBound('s5')), summary(intBound(670), intBound(680)))
    expect(f(p)).toBe(true)
  })

  it('skips when site matches but month is out of range', () => {
    const f = stringFilter('s3', 'web', MONTHS)
    const p = parts(summary(strBound('s1'), strBound('s5')), summary(intBound(600), intBound(650)))
    expect(f(p)).toBe(false)
  })

  it('keeps when a site bound is absent (cannot prune that dimension)', () => {
    const f = stringFilter('s9', 'web', MONTHS)
    const p = parts(summary(undefined, undefined), summary(intBound(670), intBound(680)))
    expect(f(p)).toBe(true)
  })

  it('keeps a single-site manifest (lower == upper == target)', () => {
    const f = stringFilter('site-abc', 'web', MONTHS)
    const p = parts(summary(strBound('site-abc'), strBound('site-abc')), summary(intBound(676), intBound(676)))
    expect(f(p)).toBe(true)
  })

  // --- search_type pruning -------------------------------------------------

  it('skips when the target search_type is outside a single-type manifest bound', () => {
    // A manifest holding only `web` appends: bound is `[web, web]`. A `discover`
    // query proves it cannot match → skip without fetching entries.
    const f = stringFilter('s3', 'discover', MONTHS)
    const p = parts(
      summary(strBound('s1'), strBound('s5')),
      summary(intBound(670), intBound(680)),
      summary(strBound('web'), strBound('web')),
    )
    expect(f(p)).toBe(false)
  })

  it('keeps when the target search_type falls inside a mixed-type manifest bound', () => {
    // A manifest spanning `discover`..`web` could hold `news` → keep.
    const f = stringFilter('s3', 'news', MONTHS)
    const p = parts(
      summary(strBound('s1'), strBound('s5')),
      summary(intBound(670), intBound(680)),
      summary(strBound('discover'), strBound('web')),
    )
    expect(f(p)).toBe(true)
  })

  it('keeps when the target search_type equals a single-type bound', () => {
    const f = stringFilter('s3', 'web', MONTHS)
    const p = parts(
      summary(strBound('s1'), strBound('s5')),
      summary(intBound(670), intBound(680)),
      summary(strBound('web'), strBound('web')),
    )
    expect(f(p)).toBe(true)
  })

  it('keeps when the search_type bound is absent (cannot prune that dimension)', () => {
    const f = stringFilter('s3', 'discover', MONTHS)
    const p = parts(
      summary(strBound('s1'), strBound('s5')),
      summary(intBound(670), intBound(680)),
      summary(undefined, undefined),
    )
    expect(f(p)).toBe(true)
  })

  it('prunes on search_type even when site and month both match', () => {
    const f = stringFilter('s3', 'image', MONTHS)
    const p = parts(
      summary(strBound('s1'), strBound('s5')),
      summary(intBound(670), intBound(680)),
      summary(strBound('web'), strBound('web')),
    )
    expect(f(p)).toBe(false)
  })
})
