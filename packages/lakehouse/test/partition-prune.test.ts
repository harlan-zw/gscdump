/**
 * Unit tests for the generalized manifest-list partition pruner (ported +
 * generalized from `@gscdump/engine`'s `iceberg-partition-prune.test.ts` to
 * the arbitrary-partition-spec + `PartitionValueMatch[]` shape).
 */

import type { IcebergFieldSummary } from '../src/partition-prune'
import { describe, expect, it } from 'vitest'
import { buildManifestPartitionFilter } from '../src/partition-prune'

const SPEC = [
  { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
  { sourceColumn: 'searchType', transform: 'identity' as const, name: 'search_type' },
  { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
]

function strBound(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function intBound(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setInt32(0, n, true)
  return b
}

function summary(lower?: Uint8Array, upper?: Uint8Array): IcebergFieldSummary {
  return { contains_null: false, lower_bound: lower ?? null, upper_bound: upper ?? null }
}

function parts(site: IcebergFieldSummary, month: IcebergFieldSummary, searchType: IcebergFieldSummary = summary()): IcebergFieldSummary[] {
  return [site, searchType, month]
}

const MONTHS = new Set([676])

function stringFilter(siteId: string, searchType: string, months: ReadonlySet<number>) {
  return buildManifestPartitionFilter(SPEC, [
    { field: 'site_id', value: siteId, encoding: 'string' },
    { field: 'search_type', value: searchType, encoding: 'string' },
  ], months)
}

describe('buildManifestPartitionFilter', () => {
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

  it('does not prune int32-encoded fields (single-tenant, per-file check remains authoritative)', () => {
    const f = buildManifestPartitionFilter(SPEC, [{ field: 'site_id', value: 9, encoding: 'int32' }], MONTHS)
    const p = parts(summary(strBound('s1'), strBound('s5')), summary(intBound(676), intBound(676)))
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

  it('keeps when a site bound is absent (cannot prune that dimension)', () => {
    const f = stringFilter('s9', 'web', MONTHS)
    const p = parts(summary(undefined, undefined), summary(intBound(670), intBound(680)))
    expect(f(p)).toBe(true)
  })

  it('skips when the target search_type is outside a single-type manifest bound', () => {
    const f = stringFilter('s3', 'discover', MONTHS)
    const p = parts(
      summary(strBound('s1'), strBound('s5')),
      summary(intBound(670), intBound(680)),
      summary(strBound('web'), strBound('web')),
    )
    expect(f(p)).toBe(false)
  })

  it('keeps when the target search_type falls inside a mixed-type manifest bound', () => {
    const f = stringFilter('s3', 'news', MONTHS)
    const p = parts(
      summary(strBound('s1'), strBound('s5')),
      summary(intBound(670), intBound(680)),
      summary(strBound('discover'), strBound('web')),
    )
    expect(f(p)).toBe(true)
  })

  it('keeps a single-site manifest (lower == upper == target)', () => {
    const f = stringFilter('site-abc', 'web', MONTHS)
    const p = parts(summary(strBound('site-abc'), strBound('site-abc')), summary(intBound(676), intBound(676)))
    expect(f(p)).toBe(true)
  })

  it('with no wantedMonths supplied, skips month pruning entirely', () => {
    const f = buildManifestPartitionFilter(SPEC, [{ field: 'site_id', value: 's3', encoding: 'string' }])
    const p = parts(summary(strBound('s1'), strBound('s5')), summary(intBound(1), intBound(2)))
    expect(f(p)).toBe(true)
  })
})
