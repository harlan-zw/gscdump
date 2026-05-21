import { describe, expect, it } from 'vitest'
import { createStorageEngine } from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

function makeEngine() {
  const dataSource = createInMemoryDataSource()
  const manifestStore = createInMemoryManifestStore()
  const codec = createJsonCodec()
  const executor = createUnionExecutor(codec)
  return createStorageEngine({ dataSource, manifestStore, codec, executor })
}

describe('runSQL multi-table ambiguity', () => {
  it('throws when fileSets reference multiple tables and opts.table is not set', async () => {
    const engine = makeEngine()
    await expect(
      engine.runSQL({
        ctx: { userId: 'u1', siteId: 's1' },
        fileSets: {
          FILES: { table: 'pages' },
          FILES_PREV: { table: 'queries' },
        },
        sql: 'SELECT 1',
      }),
    ).rejects.toThrow(/requires explicit ctx\.table when fileSets reference multiple tables/)
  })

  it('accepts multi-table fileSets when opts.table is explicit', async () => {
    const engine = makeEngine()
    const res = await engine.runSQL({
      ctx: { userId: 'u1', siteId: 's1' },
      fileSets: {
        FILES: { table: 'pages' },
        FILES_PREV: { table: 'queries' },
      },
      table: 'pages',
      sql: 'SELECT 1',
    })
    expect(res.rows).toBeDefined()
  })
})
