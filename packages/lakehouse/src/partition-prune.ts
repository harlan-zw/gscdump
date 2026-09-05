/**
 * Manifest-list partition pruning for the catalog read path — generalized
 * (ADR-0021 amendment 9) from the engine's `site_id`/`search_type`-hardcoded
 * version to accept an arbitrary partition spec + arbitrary identity/dims
 * value matches, so any dataset def's reader benefits from the same pruning.
 *
 * The manifest-LIST avro already carries each manifest's `partitions`
 * field-summary bounds (in partition-spec field order) — in hand the moment the
 * list is parsed, BEFORE any manifest's entries are fetched. The patched
 * `icebergManifests` accepts a `partitionFilter` that runs against those
 * summaries; returning `false` skips fetching that manifest entirely.
 *
 * Safety: this is an inclusive projection (Iceberg scan planning) — a manifest
 * is skipped only when its summary bounds PROVE it cannot hold the target
 * slice; any uncertainty (missing summaries, null bound) keeps the manifest, so
 * pruning never drops a matching file, only avoids reading non-matching ones.
 */

import type { IcebergPartitionField } from './schema'

/** Minimal shape of an icebird manifest-list `partitions` field-summary. */
export interface IcebergFieldSummary {
  contains_null: boolean
  contains_nan?: boolean | null
  lower_bound?: Uint8Array | null
  upper_bound?: Uint8Array | null
}

/** Predicate handed to icebird's patched `icebergManifests({ partitionFilter })`. */
export type ManifestPartitionFilter = (partitions: IcebergFieldSummary[] | undefined) => boolean

/**
 * One identity/dims value to prune an `identity`-transform partition field by.
 *
 * `'int32'`-encoded fields are deliberately NOT pruned here (mirrors the
 * original engine behavior): an INT column's bound bytes are a 4-byte int, but
 * per-team catalogs are single-tenant, so identity pruning on them saves ~nothing
 * — the per-file partition check in the resolver remains the authoritative
 * correctness filter. Only `'string'`-encoded identity fields are pruned by
 * lexicographic UTF-8 bound comparison (the truncated-string-stats case R2 SQL
 * needs the workaround for).
 */
export interface PartitionValueMatch {
  /** Partition field name as declared in the partition spec (e.g. `'site_id'`). */
  field: string
  value: string | number
  encoding: 'string' | 'int32'
}

function toUint8(bytes: Uint8Array | ArrayBuffer | null | undefined): Uint8Array | null {
  if (bytes == null)
    return null
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

const UTF8_DECODER = new TextDecoder()

/** identity(<col>) lower/upper bounds are UTF-8 string bytes under `'string'` encoding. */
function decodeString(bytes: Uint8Array | ArrayBuffer | null | undefined): string | null {
  const u = toUint8(bytes)
  return u == null ? null : UTF8_DECODER.decode(u)
}

/** month(date)=<name> bounds are 4-byte little-endian int32 (months since epoch). */
function decodeMonthInt(bytes: Uint8Array | ArrayBuffer | null | undefined): number | null {
  const u = toUint8(bytes)
  if (u == null)
    return null
  return new DataView(u.buffer, u.byteOffset, u.byteLength).getInt32(0, true)
}

/**
 * Build the `partitionFilter` predicate for a slice of `matches` (identity/dims
 * value equality) plus an optional `wantedMonths` set (for a `month`-transform
 * field in `partitionSpec`). Returns `false` to skip a manifest, `true` to keep
 * it. Keep-all when a manifest carries no `partitions` summaries.
 */
export function buildManifestPartitionFilter(
  partitionSpec: readonly IcebergPartitionField[],
  matches: readonly PartitionValueMatch[],
  wantedMonths?: ReadonlySet<number>,
): ManifestPartitionFilter {
  const fieldIndex = (name: string): number => partitionSpec.findIndex(f => f.name === name || f.sourceColumn === name)
  const monthFieldIndex = partitionSpec.findIndex(f => f.transform === 'month')
  const stringMatches = matches.flatMap((match) => {
    if (match.encoding !== 'string')
      return []
    const index = fieldIndex(match.field)
    return index < 0 ? [] : [{ index, value: String(match.value) }]
  })
  const wantedMonthValues = wantedMonths
    ? [...wantedMonths].filter(Number.isFinite).sort((a, b) => a - b)
    : []

  const hasWantedMonthInRange = (lo: number, hi: number): boolean => {
    // Lower-bound search turns a scan over every requested month for every
    // manifest into O(log months), while preserving sparse month sets.
    let left = 0
    let right = wantedMonthValues.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (wantedMonthValues[middle]! < lo)
        left = middle + 1
      else
        right = middle
    }
    return left < wantedMonthValues.length && wantedMonthValues[left]! <= hi
  }

  return (partitions): boolean => {
    if (!partitions || partitions.length === 0)
      return true // no summaries — can't prune, keep

    for (const match of stringMatches) {
      const summary = partitions[match.index]
      if (!summary || (summary.lower_bound == null && summary.upper_bound == null))
        continue
      const lo = decodeString(summary.lower_bound)
      const hi = decodeString(summary.upper_bound)
      if (lo != null && hi != null && (match.value < lo || match.value > hi))
        return false
    }

    if (wantedMonthValues.length > 0 && monthFieldIndex >= 0) {
      const monthSummary = partitions[monthFieldIndex]
      if (monthSummary && (monthSummary.lower_bound != null || monthSummary.upper_bound != null)) {
        const lo = decodeMonthInt(monthSummary.lower_bound)
        const hi = decodeMonthInt(monthSummary.upper_bound)
        if (lo != null && hi != null && !hasWantedMonthInRange(lo, hi))
          return false
      }
    }

    return true
  }
}

/**
 * Sentinel for a manifest whose `month`-transform field summary does not
 * prove it is confined to exactly one month — no month field in the spec, no
 * `partitions` summary at all, an undecodable bound, or a summary spanning
 * more than one month. Callers that cache per-month manifest sets (see
 * `catalog.ts`'s `resolveIcebergDataFiles`) must always walk and never cache
 * a `'multi'` manifest: caching it under one month would silently drop it
 * from queries against any OTHER month it also covers.
 */
export const MULTI_MONTH_MANIFEST = 'multi' as const

/**
 * The single month (months-since-epoch) a manifest's partition-summary bounds
 * prove every entry in it belongs to, or {@link MULTI_MONTH_MANIFEST} when
 * that cannot be proven. A manifest is single-month only when its `month`
 * field summary has identical, decodable lower and upper bounds — i.e. the
 * manifest-list itself vouches that nothing in the manifest falls outside
 * that one month.
 */
export function manifestMonthBucket(
  partitionSpec: readonly IcebergPartitionField[],
  partitions: IcebergFieldSummary[] | undefined,
): number | typeof MULTI_MONTH_MANIFEST {
  const monthFieldIndex = partitionSpec.findIndex(f => f.transform === 'month')
  if (monthFieldIndex < 0 || !partitions || partitions.length <= monthFieldIndex)
    return MULTI_MONTH_MANIFEST
  const monthSummary = partitions[monthFieldIndex]
  if (!monthSummary || (monthSummary.lower_bound == null && monthSummary.upper_bound == null))
    return MULTI_MONTH_MANIFEST
  const lo = decodeMonthInt(monthSummary.lower_bound)
  const hi = decodeMonthInt(monthSummary.upper_bound)
  if (lo == null || hi == null || lo !== hi)
    return MULTI_MONTH_MANIFEST
  return lo
}
