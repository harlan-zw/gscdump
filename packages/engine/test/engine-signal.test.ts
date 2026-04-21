import type { Row, WriteCtx } from '../src/index'
import { describe, expect, it } from 'vitest'
import { createStorageEngine } from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

function makeCtx(partial: Partial<WriteCtx> = {}): WriteCtx {
  return {
    userId: 'u1',
    siteId: 's1',
    table: 'pages',
    date: '2026-04-10',
    ...partial,
  }
}

function pageRow(url: string, date: string, clicks = 1, impressions = 10): Row {
  return { url, date, clicks, impressions, sum_position: impressions * 5 }
}

function makeEngine() {
  const dataSource = createInMemoryDataSource()
  const manifestStore = createInMemoryManifestStore()
  const codec = createJsonCodec()
  const executor = createUnionExecutor(codec)
  const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })
  return { engine, dataSource }
}

describe('engine read path honors AbortSignal', () => {
  it('runSQL throws when signal is already aborted', async () => {
    const { engine } = makeEngine()
    await engine.writeDay(makeCtx(), [pageRow('/', '2026-04-10')])

    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(engine.runSQL({
      ctx: { userId: 'u1', siteId: 's1' },
      table: 'pages',
      fileSets: { FILES: { table: 'pages' } },
      sql: 'SELECT * FROM {{FILES}}',
      signal: controller.signal,
    })).rejects.toThrow('cancelled')
  })

  it('query forwards ctx.signal through runSQL', async () => {
    const { engine } = makeEngine()
    await engine.writeDay(makeCtx(), [pageRow('/', '2026-04-10')])

    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(engine.query(
      { userId: 'u1', siteId: 's1', table: 'pages', signal: controller.signal },
      {
        dimensions: ['page'],
        filter: {
          _filters: [{
            dimension: 'date',
            operator: 'between',
            expression: '2026-04-10',
            expression2: '2026-04-10',
          }],
        } as any,
      },
    )).rejects.toThrow('cancelled')
  })

  it('runSQL completes normally when signal is provided but not aborted', async () => {
    const { engine } = makeEngine()
    await engine.writeDay(makeCtx(), [pageRow('/', '2026-04-10')])

    const controller = new AbortController()
    const result = await engine.runSQL({
      ctx: { userId: 'u1', siteId: 's1' },
      table: 'pages',
      fileSets: { FILES: { table: 'pages' } },
      sql: 'SELECT * FROM {{FILES}}',
      signal: controller.signal,
    })
    expect(result.rows).toHaveLength(1)
  })
})
