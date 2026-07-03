// Behavioral guard: a LIST failure against the Iceberg REST catalog must
// SURFACE, not be masked as an empty table list. Ported from
// `@gscdump/engine`'s `iceberg-catalog-list-surfacing.test.ts`.

import { describe, expect, it, vi } from 'vitest'

const restCatalogListTables = vi.fn()
const icebergDropTable = vi.fn()

vi.mock('icebird', () => ({
  cachingResolver: (r: unknown) => r,
  icebergAppend: vi.fn(),
  icebergCreateTable: vi.fn(),
  icebergDropTable,
  icebergManifests: vi.fn(),
  restCatalogConnect: vi.fn(),
  restCatalogCreateNamespace: vi.fn(),
  restCatalogListTables,
  restCatalogLoadTable: vi.fn(),
  s3SignedResolver: vi.fn(),
}))

const { listIcebergTables, dropIcebergTables } = await import('../src/catalog')

const CONN = { catalog: {} as never, resolver: {} as never, namespace: 'crawl' }
const LIST_FAILURE = 'catalog list failed (network / 401)'

describe('listIcebergTables: list failure surfacing', () => {
  it('surfaces a list failure instead of returning an empty list', async () => {
    restCatalogListTables.mockRejectedValueOnce(new Error(LIST_FAILURE))
    await expect(listIcebergTables(CONN)).rejects.toThrow(LIST_FAILURE)
  })

  it('returns the sorted names for a genuinely-listed namespace', async () => {
    restCatalogListTables.mockResolvedValueOnce([{ name: 'queries' }, { name: 'pages' }])
    await expect(listIcebergTables(CONN)).resolves.toEqual(['pages', 'queries'])
  })
})

describe('dropIcebergTables: list failure surfacing', () => {
  it('surfaces a list failure when discovering the default target set', async () => {
    restCatalogListTables.mockRejectedValueOnce(new Error(LIST_FAILURE))
    await expect(dropIcebergTables(CONN)).rejects.toThrow(LIST_FAILURE)
    expect(icebergDropTable).not.toHaveBeenCalled()
  })
})
