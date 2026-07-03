/**
 * Manifest-list partition pruning for the `gsc.*` read path — GSC-specific
 * `(siteId, searchType, wantedMonths, encoding)` signature preserved for
 * non-breaking compatibility; the mechanics MOVED to
 * `@gscdump/lakehouse`'s generalized `buildManifestPartitionFilter`
 * (ADR-0021 amendment 9).
 */

import type { ManifestPartitionFilter, PartitionValueMatch } from '@gscdump/lakehouse'
import type { PartitionKeyEncoding } from './schema'
import { buildManifestPartitionFilter } from '@gscdump/lakehouse'
import { DEFAULT_PARTITION_KEY_ENCODING, ICEBERG_PARTITION_SPEC } from './schema'

export type { IcebergFieldSummary, ManifestPartitionFilter } from '@gscdump/lakehouse'

/**
 * Build the `partitionFilter` predicate for one
 * `(siteId, searchType, wantedMonths)` slice. Returns `false` to skip a
 * manifest, `true` to keep it.
 *
 * `'int'`-encoded identity fields are deliberately NOT pruned here — see
 * `@gscdump/lakehouse`'s `partition-prune.ts` doc (per-team catalogs are
 * single-tenant, so identity pruning on them saves ~nothing; the per-file
 * check in `listIcebergDataFiles` remains authoritative).
 */
export function buildPartitionFilter(
  siteId: string | number,
  searchType: string | number,
  wantedMonths: ReadonlySet<number>,
  encoding: PartitionKeyEncoding = DEFAULT_PARTITION_KEY_ENCODING,
): ManifestPartitionFilter {
  const matches: PartitionValueMatch[] = encoding === 'string'
    ? [
        { field: 'site_id', value: siteId, encoding: 'string' },
        { field: 'search_type', value: searchType, encoding: 'string' },
      ]
    : []
  return buildManifestPartitionFilter(ICEBERG_PARTITION_SPEC, matches, wantedMonths)
}
