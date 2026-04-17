import type { ParquetCodec } from '../../src/analytics'
import { describe, expect, it } from 'vitest'
import { createStorageEngine, MAX_DAY_BYTES } from '../../src/analytics'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createUnionExecutor,
} from '../helpers/in-memory'

describe('engine MAX_DAY_BYTES enforcement', () => {
  it('throws when codec reports bytes > MAX_DAY_BYTES and leaves no artifacts behind', async () => {
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()

    const oversizeCodec: ParquetCodec = {
      async writeRows(_ctx, rows, key, ds) {
        // Write a tiny sentinel so we can verify it's cleaned up.
        await ds.write(key, new Uint8Array([1]))
        return { bytes: MAX_DAY_BYTES + 1, rowCount: rows.length }
      },
      async readRows() {
        return []
      },
      async compactRows() {
        return { bytes: 0, rowCount: 0 }
      },
    }

    const engine = createStorageEngine({
      dataSource,
      manifestStore,
      codec: oversizeCodec,
      executor: createUnionExecutor(oversizeCodec),
    })

    await expect(
      engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
        [{ url: '/', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }],
      ),
    ).rejects.toThrow(/exceeds .* hard ceiling/)

    expect(manifestStore.all()).toHaveLength(0)

    const keys = await dataSource.list('u_')
    expect(keys).toHaveLength(0)
  })
})
