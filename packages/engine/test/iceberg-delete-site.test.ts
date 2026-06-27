/**
 * Unit test for `deleteSiteFromShard` — the per-site Iceberg delete recovery
 * op. Drives a FAKE backend (no Python / POC stack), so it asserts the job
 * shaping + sweep semantics: one delete job per table, sequential, every table
 * attempted even when one fails, results carry per-table outcomes.
 *
 * The real PyIceberg `op:'delete'` (`table.delete(delete_filter=EqualTo(
 * 'site_id', N))`) is exercised by the live overwrite integration suite when
 * the stack is up; here we pin the transport-agnostic contract.
 */

import type { OverwriteWriterCatalogConfig, PyIcebergJob } from '../src/iceberg/overwrite-writer'
import { describe, expect, it } from 'vitest'
import { deleteSiteFromShard } from '../src/iceberg/overwrite-writer'

const CATALOG: OverwriteWriterCatalogConfig = {
  catalogUri: 'https://catalog.example/acct/gsc-team-x-int',
  namespace: 'gsc',
  warehouse: 'acct_gsc-team-x-int',
  s3: { endpoint: 'https://acct.r2.example', accessKeyId: 'k', secretAccessKey: 's', region: 'auto' },
}

describe('deleteSiteFromShard', () => {
  it('issues one delete job per table, sequentially, with site_id + table set', async () => {
    const seen: PyIcebergJob[] = []
    const backend = async (job: PyIcebergJob) => {
      seen.push(job)
      return { rowCount: 10 }
    }
    const tables = ['pages', 'queries', 'page_queries']
    const results = await deleteSiteFromShard({ catalog: CATALOG, backend, siteId: 42, tables })

    expect(seen.map(j => j.table)).toEqual(tables) // order preserved (sequential)
    expect(seen.every(j => j.op === 'delete')).toBe(true)
    expect(seen.every(j => j.siteId === 42)).toBe(true)
    expect(seen.every(j => j.warehouse === CATALOG.warehouse)).toBe(true)
    expect(results).toEqual(tables.map(table => ({ table, rowCount: 10 })))
  })

  it('continues the sweep when one table fails, capturing the error per-table', async () => {
    const backend = async (job: PyIcebergJob) =>
      job.table === 'queries' ? { error: 'boom' } : { rowCount: 5 }
    const results = await deleteSiteFromShard({
      catalog: CATALOG,
      backend,
      siteId: 'site-str',
      tables: ['pages', 'queries', 'countries'],
    })
    expect(results).toEqual([
      { table: 'pages', rowCount: 5 },
      { table: 'queries', error: 'boom' },
      { table: 'countries', rowCount: 5 },
    ])
  })

  it('captures a thrown backend rejection as the table error (sweep never throws)', async () => {
    const backend = async (job: PyIcebergJob) => {
      if (job.table === 'pages')
        throw new Error('subprocess died')
      return { rowCount: 1 }
    }
    const results = await deleteSiteFromShard({ catalog: CATALOG, backend, siteId: 1, tables: ['pages', 'dates'] })
    expect(results[0]).toEqual({ table: 'pages', error: 'subprocess died' })
    expect(results[1]).toEqual({ table: 'dates', rowCount: 1 })
  })
})
