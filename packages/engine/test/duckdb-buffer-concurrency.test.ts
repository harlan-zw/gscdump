import type { DuckDBHandle } from '@gscdump/engine'
import type { Row } from '@gscdump/engine/contracts'
import { createDuckDBExecutor } from '@gscdump/engine'
import { encodeRowsToParquet } from '@gscdump/engine/hyparquet'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createInMemoryDataSource } from './helpers/in-memory'

const key = 'shared.parquet'

function sourceWithRows(rows: Row[]) {
  return createInMemoryDataSource(new Map([[key, encodeRowsToParquet('pages', rows)]]))
}

function pageRow(url: string, clicks = 7, date = '2026-04-10'): Row {
  return { url, date, clicks, impressions: 100, sum_position: 300 }
}

function barrier() {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return { ready, release }
}

function overlapRegistrations(handle: DuckDBHandle): DuckDBHandle {
  const registered = barrier()
  let registrations = 0
  return {
    ...handle,
    async registerFileBuffer(name, bytes) {
      await handle.registerFileBuffer(name, bytes)
      if (++registrations === 2)
        registered.release()
      await registered.ready
    },
  }
}

const query = {
  sql: 'SELECT url, clicks::INT AS clicks FROM read_parquet({{FILES}})',
  params: [],
  fileKeys: { FILES: [key] },
  table: 'pages' as const,
}

afterAll(() => {
  resetNodeDuckDB()
})

describe('duckDB buffered queries', () => {
  beforeEach(() => {
    resetNodeDuckDB()
  })

  it('isolates concurrent queries when different DataSources use the same object key', async () => {
    const left = sourceWithRows([pageRow('/left')])
    const right = sourceWithRows([pageRow('/right')])
    // Both registrations finish before either query reads its real Parquet file.
    const handle = overlapRegistrations(createNodeDuckDBHandle())
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })

    const results = await Promise.allSettled([
      executor.execute({ ...query, dataSource: left }),
      executor.execute({ ...query, dataSource: right }),
    ])
    const rows = results.map((result) => {
      if (result.status === 'rejected')
        throw result.reason
      return result.value.rows
    })

    expect(rows).toEqual([[{ url: '/left', clicks: 7 }], [{ url: '/right', clicks: 7 }]])
  })

  it('keeps a concurrent query readable after another query releases the same object key', async () => {
    const dataSource = sourceWithRows([pageRow('/shared')])
    const handle = overlapRegistrations(createNodeDuckDBHandle())
    const firstReleased = barrier()
    let queries = 0
    const scheduled: DuckDBHandle = {
      ...handle,
      async query(sql, params) {
        if (++queries === 2)
          await firstReleased.ready
        return handle.query(sql, params)
      },
      async dropFiles(names) {
        await handle.dropFiles(names)
        firstReleased.release()
      },
    }
    const executor = createDuckDBExecutor({ getDuckDB: async () => scheduled })

    const results = await Promise.allSettled([
      executor.execute({ ...query, dataSource }),
      executor.execute({ ...query, dataSource }),
    ])
    const rows = results.map((result) => {
      if (result.status === 'rejected')
        throw result.reason
      return result.value.rows
    })

    expect(rows).toEqual([[{ url: '/shared', clicks: 7 }], [{ url: '/shared', clicks: 7 }]])
  })

  it('binds quoted Unicode filters, numbers, booleans, null, and dates in a Parquet query', async () => {
    const target = '/O\'Reilly/日本'
    const dataSource = sourceWithRows([
      pageRow(target),
      pageRow(target, 3, '2026-04-09'),
      pageRow('/other', 99),
    ])
    const handle = createNodeDuckDBHandle()
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })

    const result = await executor.execute({
      ...query,
      dataSource,
      sql: `SELECT url, clicks::INT AS clicks, $3::DOUBLE AS ratio, $4::BOOLEAN AS selected, $5::VARCHAR AS absent
        FROM read_parquet({{FILES}}) WHERE url = $1 AND clicks > $2 AND date >= $6::DATE`,
      params: [target, 5, 0.25, true, null, '2026-04-10'],
    })

    expect(result.rows).toEqual([{ url: target, clicks: 7, ratio: 0.25, selected: true, absent: null }])
  })
})
