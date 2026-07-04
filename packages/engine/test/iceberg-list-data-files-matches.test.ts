/**
 * Regression test for the fleet cross-site leak (2026-07-04): the ADR-0021 C1
 * move passed `matches: []` for 'int'-encoded catalogs, deleting the per-file
 * site_id/search_type check that is the ONLY isolation boundary on a per-team
 * catalog (browser SQL never filters by site_id). `listIcebergDataFiles` must
 * pass identity matches for BOTH encodings; 'int32' ones are skipped by
 * manifest pruning but drive lakehouse's authoritative per-file check.
 */

import { describe, expect, it, vi } from 'vitest'

const resolveIcebergDataFiles = vi.fn().mockResolvedValue([])

vi.mock('@gscdump/lakehouse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gscdump/lakehouse')>()
  return { ...actual, resolveIcebergDataFiles }
})

const { listIcebergDataFiles } = await import('../src/iceberg/catalog')

const CONN = { catalog: {} as never, resolver: {} as never, namespace: 'gsc' } as never
const RANGE = { start: '2026-05-01', end: '2026-05-31' }

describe('listIcebergDataFiles identity matches', () => {
  it('int encoding passes int32 site_id + search_type matches (per-file isolation)', async () => {
    await listIcebergDataFiles(CONN, {
      table: 'pages',
      siteId: 42,
      searchType: 1,
      encoding: 'int',
      range: RANGE,
    })
    expect(resolveIcebergDataFiles).toHaveBeenLastCalledWith(CONN, expect.objectContaining({
      matches: [
        { field: 'site_id', value: 42, encoding: 'int32' },
        { field: 'search_type', value: 1, encoding: 'int32' },
      ],
    }))
  })

  it('string encoding passes string matches (manifest-pruned + per-file)', async () => {
    await listIcebergDataFiles(CONN, {
      table: 'pages',
      siteId: 's_abc',
      searchType: 'web',
      encoding: 'string',
      range: RANGE,
    })
    expect(resolveIcebergDataFiles).toHaveBeenLastCalledWith(CONN, expect.objectContaining({
      matches: [
        { field: 'site_id', value: 's_abc', encoding: 'string' },
        { field: 'search_type', value: 'web', encoding: 'string' },
      ],
    }))
  })

  it('defaults to int encoding when none is given', async () => {
    await listIcebergDataFiles(CONN, {
      table: 'queries',
      siteId: 7,
      searchType: 2,
      range: RANGE,
    })
    expect(resolveIcebergDataFiles).toHaveBeenLastCalledWith(CONN, expect.objectContaining({
      matches: [
        { field: 'site_id', value: 7, encoding: 'int32' },
        { field: 'search_type', value: 2, encoding: 'int32' },
      ],
    }))
  })
})
