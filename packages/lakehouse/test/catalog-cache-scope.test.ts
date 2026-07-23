/**
 * Regression test for the cross-catalog KV poisoning bug (2026-07-04): every
 * per-team catalog uses the same 'gsc' namespace while deployments share one
 * KV, and the snapshot-ref/metadata/file-list keys carried only
 * (namespace, table) — so whichever team resolved first pinned its snapshot
 * pointer (and metadata) for EVERY team for the TTL window. Keys must include
 * the connection's `cacheScope` (catalog identity) so two catalogs sharing a
 * cache never read each other's entries.
 */

import { createStorage } from 'unstorage'
import { describe, expect, it, vi } from 'vitest'

const restCatalogLoadTable = vi.fn()
const icebergManifests = vi.fn()

vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect: vi.fn(), restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable }))
vi.mock('icebird/src/manifest.js', () => ({ icebergManifests }))

const { catalogCacheScope, resolveIcebergDataFiles } = await import('../src/catalog')

const SPEC = [
  { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
  { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
]
const MAY = (2026 - 1970) * 12 + 4
const RANGE = { start: '2026-05-01', end: '2026-05-31' }

function conn(cacheScope: string) {
  return { catalog: {} as never, resolver: {} as never, namespace: 'gsc', cacheScope }
}

function entryFor(siteId: number, path: string) {
  return {
    status: 1,
    data_file: {
      content: 0,
      file_path: path,
      file_size_in_bytes: 1,
      record_count: 1,
      partition: { site_id: siteId, date_month: MAY },
    },
  }
}

function opts(siteId: number) {
  return {
    namespace: 'gsc',
    table: 'pages',
    partitionSpec: SPEC,
    matches: [{ field: 'site_id', value: siteId, encoding: 'int32' as const }],
    range: RANGE,
  }
}

describe('cross-catalog cache isolation', () => {
  it('two catalogs sharing one cache never see each other\'s snapshot/metadata/files', async () => {
    const cache = { storage: createStorage() }

    // Team A resolves first: snapshot snap-A, one file for site 1.
    restCatalogLoadTable.mockResolvedValueOnce({ metadata: { 'current-snapshot-id': 'snap-A' } })
    icebergManifests.mockResolvedValueOnce([{ entries: [entryFor(1, 's3://team-a/gsc/pages/a.parquet')] }])
    const teamA = await resolveIcebergDataFiles(conn('cat\0team-a-int') as never, { ...opts(1), cache })
    expect(teamA).toHaveLength(1)

    // Team B (same namespace/table, DIFFERENT catalog) must do its own
    // loadTable + walk — a shared (namespace, table) key would have served it
    // team A's snapshot pointer and cached (empty-for-B) file list instead.
    restCatalogLoadTable.mockResolvedValueOnce({ metadata: { 'current-snapshot-id': 'snap-B' } })
    icebergManifests.mockResolvedValueOnce([{ entries: [entryFor(2, 's3://team-b/gsc/pages/b.parquet')] }])
    const teamB = await resolveIcebergDataFiles(conn('cat\0team-b-int') as never, { ...opts(2), cache })
    expect(teamB).toEqual([expect.objectContaining({ filePath: 's3://team-b/gsc/pages/b.parquet' })])
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(2)
    expect(icebergManifests).toHaveBeenCalledTimes(2)

    // Same catalog + same query stays warm (cache still works within a scope).
    const teamARepeat = await resolveIcebergDataFiles(conn('cat\0team-a-int') as never, { ...opts(1), cache })
    expect(teamARepeat).toEqual(teamA)
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(2)
  })

  it('catalogCacheScope derives from catalogUri + warehouse', () => {
    expect(catalogCacheScope({ catalogUri: 'https://cat', warehouse: 'team-7-int' }))
      .toBe('https://cat\0team-7-int')
  })
})
