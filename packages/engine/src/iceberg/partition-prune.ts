/**
 * Manifest-list partition pruning for the catalog read path.
 *
 * The shared `gsc.<table>` fact tables are multi-tenant: every site's parquet
 * files live under one manifest set. A naive read fetches EVERY manifest in the
 * current snapshot and filters to one site in JS — O(all tenants). At 10k
 * tenants that is thousands of manifest fetches to answer a single-site query.
 *
 * The manifest-LIST avro already carries each manifest's `partitions`
 * field-summary bounds (in partition-spec field order) — in hand the moment the
 * list is parsed, BEFORE any manifest's entries are fetched. icebird's patched
 * `icebergManifests` accepts a `partitionFilter` that runs against those
 * summaries; returning `false` skips fetching that manifest entirely. Because
 * appends are single-site, this makes the manifest-fetch count INDEPENDENT of
 * tenant count.
 *
 * Safety: this is an inclusive projection (Iceberg scan planning) — a manifest
 * is skipped only when its summary bounds PROVE it cannot hold the target
 * slice; any uncertainty (missing summaries, null bound) keeps the manifest, so
 * pruning never drops a matching file, only avoids reading non-matching ones.
 */

import { ICEBERG_PARTITION_SPEC } from './schema'

/**
 * Minimal shape of an icebird manifest-list `partitions` field-summary. icebird
 * doesn't re-export its `Manifest`/`FieldSummary` types from the package root,
 * and this predicate only touches the bound bytes, so the shape is mirrored
 * here rather than imported.
 */
export interface IcebergFieldSummary {
  contains_null: boolean
  contains_nan?: boolean | null
  lower_bound?: Uint8Array | null
  upper_bound?: Uint8Array | null
}

/** Predicate handed to icebird's patched `icebergManifests({ partitionFilter })`. */
export type ManifestPartitionFilter = (partitions: IcebergFieldSummary[] | undefined) => boolean

// Partition-spec field indices, resolved from the canonical spec rather than
// hardcoded, so a spec reorder is followed automatically. The locked spec is
// `identity(site_id) + identity(search_type) + month(date)=date_month`.
const SITE_ID_FIELD_INDEX = ICEBERG_PARTITION_SPEC.findIndex(
  f => f.sourceColumn === 'site_id' && f.transform === 'identity',
)
const SEARCH_TYPE_FIELD_INDEX = ICEBERG_PARTITION_SPEC.findIndex(
  f => f.sourceColumn === 'search_type' && f.transform === 'identity',
)
const DATE_MONTH_FIELD_INDEX = ICEBERG_PARTITION_SPEC.findIndex(
  f => f.transform === 'month',
)

function toUint8(bytes: Uint8Array | ArrayBuffer | null | undefined): Uint8Array | null {
  if (bytes == null)
    return null
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

/** identity(site_id) lower/upper bounds are UTF-8 string bytes. */
function decodeString(bytes: Uint8Array | ArrayBuffer | null | undefined): string | null {
  const u = toUint8(bytes)
  return u == null ? null : new TextDecoder().decode(u)
}

/** month(date)=date_month bounds are 4-byte little-endian int32 (months since epoch). */
function decodeInt(bytes: Uint8Array | ArrayBuffer | null | undefined): number | null {
  const u = toUint8(bytes)
  if (u == null)
    return null
  return new DataView(u.buffer, u.byteOffset, u.byteLength).getInt32(0, true)
}

/**
 * Build the `partitionFilter` predicate for one
 * `(siteId, searchType, wantedMonths)` slice. Returns `false` to skip a
 * manifest, `true` to keep it. Keep-all when a manifest carries no `partitions`
 * summaries (cannot safely prune).
 *
 * site_id and search_type are both `identity` partitions, so their bounds are
 * compared lexicographically on the truncated UTF-8 prefix Iceberg stores —
 * `value < lo || value > hi` is a conservative, never-drops test (verified
 * against a brute-force walk at 0 false negatives). Pruning search_type as well
 * as site_id matters for multi-search-type tenants (web + Discover + News +
 * image): a single-type append yields a tight `[type, type]` bound, so the
 * other types' manifests skip the entry fetch instead of being fetched then
 * dropped at the entry-level filter. date_month keeps the manifest when ANY
 * wanted month falls inside its `[lo, hi]` range.
 */
export function buildPartitionFilter(
  siteId: string,
  searchType: string,
  wantedMonths: ReadonlySet<number>,
): ManifestPartitionFilter {
  return (partitions): boolean => {
    const parts = partitions
    if (!parts || parts.length === 0)
      return true // no summaries — can't prune, keep

    const siteSummary = parts[SITE_ID_FIELD_INDEX]
    if (siteSummary && (siteSummary.lower_bound != null || siteSummary.upper_bound != null)) {
      const lo = decodeString(siteSummary.lower_bound)
      const hi = decodeString(siteSummary.upper_bound)
      if (lo != null && hi != null && (siteId < lo || siteId > hi))
        return false
    }

    const searchTypeSummary = parts[SEARCH_TYPE_FIELD_INDEX]
    if (searchTypeSummary && (searchTypeSummary.lower_bound != null || searchTypeSummary.upper_bound != null)) {
      const lo = decodeString(searchTypeSummary.lower_bound)
      const hi = decodeString(searchTypeSummary.upper_bound)
      if (lo != null && hi != null && (searchType < lo || searchType > hi))
        return false
    }

    const monthSummary = parts[DATE_MONTH_FIELD_INDEX]
    if (monthSummary && (monthSummary.lower_bound != null || monthSummary.upper_bound != null)) {
      const lo = decodeInt(monthSummary.lower_bound)
      const hi = decodeInt(monthSummary.upper_bound)
      if (lo != null && hi != null) {
        let anyInRange = false
        for (const wm of wantedMonths) {
          if (wm >= lo && wm <= hi) {
            anyInRange = true
            break
          }
        }
        if (!anyInRange)
          return false
      }
    }

    return true
  }
}
