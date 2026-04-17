// useInsightRunner() — client-only composable that boots DuckDB-WASM,
// fetches per-table same-origin Parquet URLs, downloads each object's
// bytes in parallel, registers them in DuckDB-WASM's virtual filesystem,
// then creates one view per table over `read_parquet([virtual names])`.
//
// Why not httpfs? DuckDB-WASM probes each file with HEAD before GET; on a
// cross-origin bucket without CORS that fails. Fetching bytes through a
// same-origin Nitro proxy (/api/r2-data) sidesteps the whole CORS dance
// and avoids HEAD probes entirely — one plain GET per file, HTTP/2
// multiplexed over a single connection.

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

export interface QueryResult {
  rows: Record<string, unknown>[]
  /** ms the query spent inside DuckDB (not including JS row conversion). */
  queryMs: number
}

interface BootTimings {
  bootMs: number
  manifestMs: number
  attachMs: number
}

interface RunnerState extends BootTimings {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
}

let sharedBoot: Promise<RunnerState> | null = null

async function boot(): Promise<RunnerState> {
  const { getJsDelivrBundles, selectBundle, AsyncDuckDB, ConsoleLogger } = await import('@duckdb/duckdb-wasm')

  const t0 = performance.now()
  const bundles = getJsDelivrBundles()
  const bundle = await selectBundle(bundles)
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(workerUrl)
  const db = new AsyncDuckDB(new ConsoleLogger(), worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)
  const conn = await db.connect()
  const bootMs = performance.now() - t0

  const t1 = performance.now()
  const sources = await $fetch<{ tables: Record<string, string[]> }>('/api/analysis-sources')
  const manifestMs = performance.now() - t1

  // Flatten every (table, url) across every table into one parallel pool.
  // Previously we Promise.all'd per table and awaited between tables — with
  // 5 tables × ~hundreds of files that collapsed to 5 serial rounds of
  // browser-bound-by-connection-limit fetches. One pool multiplexes the lot.
  const flat: { table: string, url: string, idx: number }[] = []
  const perTableCounts: Record<string, number> = {}
  for (const [table, urls] of Object.entries(sources.tables)) {
    if (!Array.isArray(urls) || urls.length === 0)
      continue
    perTableCounts[table] = urls.length
    for (let i = 0; i < urls.length; i++)
      flat.push({ table, url: urls[i]!, idx: i })
  }

  const t2 = performance.now()
  await Promise.all(flat.map(async ({ table, url, idx }) => {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok)
      throw new Error(`fetch ${url} failed: ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    await db.registerFileBuffer(`${table}_${idx}.parquet`, bytes)
  }))

  for (const table of Object.keys(perTableCounts)) {
    const names: string[] = []
    for (let i = 0; i < perTableCounts[table]!; i++) names.push(`'${table}_${i}.parquet'`)
    await conn.query(
      `CREATE OR REPLACE VIEW main.${table} AS SELECT * FROM read_parquet([${names.join(', ')}], union_by_name = true)`,
    )
  }
  const attachMs = performance.now() - t2

  return { db, conn, bootMs, manifestMs, attachMs }
}

export interface AnalyzeResult {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  queryMs: number
}

export interface InsightRunner {
  /** Run arbitrary SQL against the attached parquet views (schema `main`). */
  query: (sql: string) => Promise<QueryResult>
  /**
   * Run one of the packaged analyzers (`striking-distance`, `opportunity`,
   * `brand`, `clustering`, `concentration`, `seasonality`, `movers`). Passes
   * through to `analyzeInBrowser` from `@gscdump/analysis/duckdb`.
   */
  analyze: (params: Record<string, unknown> & { type: string }) => Promise<AnalyzeResult>
  isReady: Ref<boolean>
  bootError: Ref<Error | null>
  bootTimings: Ref<BootTimings | null>
}

export function useInsightRunner(): InsightRunner {
  const isReady = ref(false)
  const bootError = ref<Error | null>(null)
  const bootTimings = ref<BootTimings | null>(null)

  onMounted(() => {
    if (!sharedBoot)
      sharedBoot = boot()
    sharedBoot
      .then(({ bootMs, manifestMs, attachMs }) => {
        bootTimings.value = { bootMs, manifestMs, attachMs }
        isReady.value = true
      })
      .catch((err: Error) => {
        sharedBoot = null
        bootError.value = err
      })
  })

  async function query(sql: string): Promise<QueryResult> {
    if (!sharedBoot)
      throw new Error('useInsightRunner: called before boot')
    const state = await sharedBoot
    const t0 = performance.now()
    const arrow = await state.conn.query(sql)
    const queryMs = performance.now() - t0
    const rows = (arrow as unknown as { toArray: () => Array<{ toJSON: () => Record<string, unknown> }> })
      .toArray()
      .map(r => (typeof r.toJSON === 'function' ? r.toJSON() : (r as unknown as Record<string, unknown>)))
    return { rows, queryMs }
  }

  async function analyze(params: Record<string, unknown> & { type: string }): Promise<AnalyzeResult> {
    if (!sharedBoot)
      throw new Error('useInsightRunner: called before boot')
    const state = await sharedBoot
    const { analyzeInBrowser } = await import('@gscdump/analysis/duckdb')
    const runner = {
      query: async (sql: string, bindParams?: unknown[]) => {
        const { bindLiterals } = await import('gscdump/analytics')
        const final = bindParams && bindParams.length > 0 ? bindLiterals(sql, bindParams) : sql
        const arrow = await state.conn.query(final)
        return (arrow as unknown as { toArray: () => Array<{ toJSON: () => Record<string, unknown> }> })
          .toArray()
          .map(r => (typeof r.toJSON === 'function' ? r.toJSON() : (r as unknown as Record<string, unknown>)))
      },
    }
    const t0 = performance.now()
    const result = await analyzeInBrowser(runner, { schema: 'main' }, params as never)
    const queryMs = performance.now() - t0
    return {
      results: result.results as unknown as Record<string, unknown>[],
      meta: result.meta,
      queryMs,
    }
  }

  return { query, analyze, isReady, bootError, bootTimings }
}
