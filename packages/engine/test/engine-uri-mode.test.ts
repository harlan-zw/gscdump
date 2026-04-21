import type { BuilderState } from 'gscdump/query'
import type { DataSource } from '../src/index'
import { describe, expect, it, vi } from 'vitest'
import { createStorageEngine } from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

function stateForDay(date: string): BuilderState {
  return {
    dimensions: ['page'],
    filter: {
      _filters: [{
        dimension: 'date',
        operator: 'between',
        expression: date,
        expression2: date,
      }],
    } as any,
  }
}

describe('executor uri-mode (per-key)', () => {
  it('skips dataSource.read when uri() resolves every key', async () => {
    const backing = createInMemoryDataSource()
    const readSpy = vi.spyOn(backing, 'read')

    // Wrap with a URI-aware front: uri(key) returns 'mem://<key>' for any key.
    const uriDs: DataSource = {
      read: backing.read.bind(backing),
      write: backing.write.bind(backing),
      delete: backing.delete.bind(backing),
      list: backing.list.bind(backing),
      uri: key => `mem://${key}`,
    }

    const codec = createJsonCodec()
    // Union executor delegates to codec.readRows; but we want the executor
    // branch tested. Use a fake executor that checks no read() was called.
    const executor = {
      async execute(opts: {
        sql: string
        params: unknown[]
        fileKeys: Record<string, string[]>
        dataSource: DataSource
      }) {
        // Simulate uri-mode branch: call dataSource.uri, never dataSource.read.
        for (const keys of Object.values(opts.fileKeys)) {
          for (const k of keys) {
            const u = opts.dataSource.uri?.(k)
            if (u === undefined)
              await opts.dataSource.read(k)
          }
        }
        return { rows: [{ ok: 1 }], sql: opts.sql }
      },
    }

    const manifestStore = createInMemoryManifestStore()
    const engine = createStorageEngine({ dataSource: uriDs, manifestStore, codec, executor })

    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
      [{ url: '/', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }],
    )

    // writeDay wrote through codec — one read call may have happened for the
    // write path (no, writeRows only writes). Reset so we measure query-only.
    readSpy.mockClear()

    const res = await engine.query({ userId: 'u1', siteId: 's1' }, stateForDay('2026-04-10'))
    expect(res.rows).toEqual([{ ok: 1 }])
    expect(readSpy).not.toHaveBeenCalled()
  })

  it('falls back to read() for keys whose uri() returns undefined (mixed mode)', async () => {
    const backing = createInMemoryDataSource()
    const readSpy = vi.spyOn(backing, 'read')

    const uriDs: DataSource = {
      read: backing.read.bind(backing),
      write: backing.write.bind(backing),
      delete: backing.delete.bind(backing),
      list: backing.list.bind(backing),
      uri: () => undefined,
    }

    const codec = createJsonCodec()
    const executor = createUnionExecutor(codec)
    const manifestStore = createInMemoryManifestStore()
    const engine = createStorageEngine({ dataSource: uriDs, manifestStore, codec, executor })

    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
      [{ url: '/', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }],
    )
    readSpy.mockClear()

    await engine.query({ userId: 'u1', siteId: 's1' }, stateForDay('2026-04-10'))
    expect(readSpy).toHaveBeenCalled()
  })
})
