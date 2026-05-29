/**
 * Fast unit tests for `createIcebergOverwriteWriter` job shaping — no docker /
 * PyIceberg stack (those live in `iceberg-overwrite-writer.test.ts` and skip
 * in CI). Pins the table-name guard: `ICEBERG_SCHEMAS[slice.table]` is a
 * `Record<IcebergTableName, …>` lookup that silently yields `undefined` for a
 * non-canonical table name, so the writer must reject it loudly.
 */

import type { OverwriteJob } from '../src/iceberg/overwrite-writer'
import type { SinkSlice } from '../src/sink'
import { describe, expect, it } from 'vitest'
import { createIcebergOverwriteWriter } from '../src/iceberg/overwrite-writer'

const CATALOG = {
  catalogUri: 'http://localhost:8181',
  namespace: 'gsc',
  warehouse: 'wh',
  s3: { endpoint: 'localhost:9100', accessKeyId: 'k', secretAccessKey: 's' },
}

function captureWriter() {
  const jobs: OverwriteJob[] = []
  const writer = createIcebergOverwriteWriter({
    catalog: CATALOG,
    backend: async (job) => {
      jobs.push(job)
      return { rowCount: job.rows.length }
    },
  })
  return { writer, jobs }
}

const ctx = { userId: 'u1', siteId: 's1' }

describe('createIcebergOverwriteWriter — table guard + job shape', () => {
  it('builds a job with the resolved spec for a canonical table', async () => {
    const { writer, jobs } = captureWriter()
    const slice: SinkSlice = { ctx, table: 'pages', searchType: 'web', date: '2026-05-01' }
    const res = await writer.overwriteSlice(slice, [{ url: '/', date: '2026-05-01', clicks: 1 }])
    expect(res.rowCount).toBe(1)
    expect(jobs[0].table).toBe('pages')
    // spec must be the resolved table spec, not undefined.
    expect((jobs[0].spec as { table: string }).table).toBe('pages')
  })

  it('throws a clear error for a non-canonical table name instead of an undefined spec', async () => {
    const { writer, jobs } = captureWriter()
    // Cast through unknown: a runtime caller (e.g. the gated integration test
    // uses `keywords`) can pass a name outside the IcebergTableName union.
    const slice = { ctx, table: 'keywords', searchType: 'web', date: '2026-05-01' } as unknown as SinkSlice
    await expect(writer.overwriteSlice(slice, [{ query: 'x', date: '2026-05-01', clicks: 1 }]))
      .rejects
      .toThrow(/Unknown Iceberg table 'keywords'/)
    // backend never ran with a corrupt spec.
    expect(jobs).toHaveLength(0)
  })

  it('still requires slice.ctx.siteId', async () => {
    const { writer } = captureWriter()
    const slice = { ctx: { userId: 'u1' }, table: 'pages', searchType: 'web', date: '2026-05-01' } as SinkSlice
    await expect(writer.overwriteSlice(slice, [])).rejects.toThrow(/siteId is required/)
  })
})
