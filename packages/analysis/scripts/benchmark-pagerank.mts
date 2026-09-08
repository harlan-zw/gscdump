import { strictEqual } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { bipartitePagerankAnalyzer } from '../src/analyzers/bipartite-pagerank'

const dir = await mkdtemp(join(tmpdir(), 'gscdump-pagerank-'))
const db = createNodeDuckDBHandle()
const analyzer = bipartitePagerankAnalyzer.sql!
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, duckdb: await db.query('SELECT version() AS version') }))
try {
  for (const [queries, urls, edges] of [[100, 50, 500], [1000, 500, 5000], [1000, 500, 50000]]) {
    const path = join(dir, `facts-${edges}.parquet`)
    await db.query(`COPY (
      SELECT DATE '2026-04-10' AS date,
        'query_' || (i % ${queries}) AS query,
        '/page/' || ((i % ${queries} * 7 + CAST(FLOOR(i / ${queries}) AS INTEGER) * 19) % ${urls}) AS url,
        CAST(20 + (i * 17) % 997 AS BIGINT) AS impressions
      FROM range(${edges}) t(i)
    ) TO '${path}' (FORMAT PARQUET)`)
    const params = { type: 'bipartite-pagerank' as const, startDate: '2026-04-01', endDate: '2026-04-30', minImpressions: 1, limit: 2000 }
    const plan = analyzer.build(params)
    if (plan.kind !== 'sql')
      throw new Error('Expected a SQL Analyzer')
    const sql = plan.sql.replaceAll('{{FILES}}', `'${path}'`)
    const run = async () => analyzer.reduce(await db.query(sql, plan.params), { params })
    const first = await run()
    strictEqual(first.meta?.queryCount, queries)
    strictEqual(first.meta?.urlCount, urls)
    for (let i = 0; i < 3; i++)
      await run()
    const times: number[] = []
    for (let i = 0; i < 9; i++) {
      const start = performance.now()
      await run()
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    console.log(JSON.stringify({ queries, urls, edges, medianMs: times[4], minMs: times[0], maxMs: times[8], output: await run() }))
  }
}
finally {
  resetNodeDuckDB()
  await rm(dir, { recursive: true })
}
