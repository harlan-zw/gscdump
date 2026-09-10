import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { buildExtrasQueries, createIcebergResolverAdapter } from '@gscdump/engine/resolver'

// Run after building: node packages/engine/scripts/benchmark-canonical-extras.mjs
const db = createNodeDuckDBHandle()
try {
  await db.query(`
    CREATE TABLE queries AS
    SELECT 42 AS site_id, 1 AS search_type,
      DATE '2026-01-01' + CAST(d.range AS INTEGER) AS date,
      'query ' || q.range::VARCHAR AS query,
      (q.range % 100 + 1)::INTEGER AS clicks,
      (q.range % 100 + 10)::INTEGER AS impressions,
      (q.range % 100 + 10)::DOUBLE * 3 AS sum_position
    FROM range(10000) q CROSS JOIN range(180) d
  `)
  await db.query(`
    CREATE TABLE query_dim AS
    SELECT 'query ' || range::VARCHAR AS query,
      'group ' || (range // 2)::VARCHAR AS query_canonical
    FROM range(10000)
  `)
  const state = {
    dimensions: ['queryCanonical'],
    filter: { _filters: [{ dimension: 'date', operator: 'between', expression: '2026-01-01', expression2: '2026-06-30' }] },
  }
  const options = { adapter: createIcebergResolverAdapter(), siteId: 42, searchType: 1 }
  const keys = Array.from({ length: 100 }, (_, index) => `group ${index}`)
  const [full] = buildExtrasQueries(state, options)
  const [selected] = buildExtrasQueries(state, options, keys)
  const normalize = rows => rows.map(row => ({ ...row, variants: String(row.variants).split('||').sort() }))
    .sort((a, b) => String(a.joinKey).localeCompare(String(b.joinKey)))
  const keysSet = new Set(keys)
  const fullRows = await db.query(full.sql, full.params)
  const selectedRows = await db.query(selected.sql, selected.params)
  assert.deepEqual(normalize(selectedRows), normalize(fullRows.filter(row => keysSet.has(row.joinKey))))
  const before = []
  const after = []
  for (let run = 0; run < 5; run++) {
    for (const [query, samples] of [[full, before], [selected, after]]) {
      const started = performance.now()
      await db.query(query.sql, query.params)
      samples.push(performance.now() - started)
    }
  }
  const [total] = await db.query('SELECT COUNT(*) AS count FROM queries')
  const [matched] = await db.query(`
    SELECT COUNT(*) AS count FROM queries LEFT JOIN query_dim USING (query)
    WHERE query_canonical IN (${keys.map(() => '?').join(', ')})
  `, keys)
  const median = samples => Math.round([...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] * 10) / 10
  console.log(JSON.stringify({
    runtime: 'DuckDB-WASM blocking Node adapter',
    days: 180,
    returnedGroupsBefore: fullRows.length,
    returnedGroupsAfter: selectedRows.length,
    aggregationRowsBefore: Number(total.count),
    aggregationRowsAfter: Number(matched.count),
    medianMsBefore: median(before),
    medianMsAfter: median(after),
    samplesMsBefore: before.map(Math.round),
    samplesMsAfter: after.map(Math.round),
    selectedRowsEqual: true,
  }, null, 2))
}
finally {
  resetNodeDuckDB()
}
