import type {
  AnalyzeResult,
  BrowserAnalysisRuntime,
  QueryResult,
} from '@gscdump/engine-wasm'

import {
  attachParquetUrlTables,
  bootDuckDBWasm,
  createBrowserAnalysisRuntime,
} from '@gscdump/engine-wasm'

interface BootTimings {
  bootMs: number
  manifestMs: number
  attachMs: number
}

interface RunnerState extends BootTimings {
  runtime: BrowserAnalysisRuntime
}

let sharedBoot: Promise<RunnerState> | null = null

async function boot(): Promise<RunnerState> {
  const t0 = performance.now()
  const booted = await bootDuckDBWasm()
  const bootMs = performance.now() - t0

  const t1 = performance.now()
  const sources = await $fetch<{ tables: Record<string, string[]> }>('/api/analysis-sources')
  const manifestMs = performance.now() - t1

  const t2 = performance.now()
  await attachParquetUrlTables({
    db: booted.db,
    conn: booted.conn,
    tables: Object.entries(sources.tables).map(([table, urls]) => ({ table, urls })),
    fetchInit: { credentials: 'same-origin' },
  })
  const attachMs = performance.now() - t2

  return {
    runtime: createBrowserAnalysisRuntime(booted, { schema: 'main' }),
    bootMs,
    manifestMs,
    attachMs,
  }
}

export interface InsightRunner {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
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

  async function query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!sharedBoot)
      throw new Error('useInsightRunner: called before boot')
    const state = await sharedBoot
    return state.runtime.query(sql, params)
  }

  async function analyze(params: Record<string, unknown> & { type: string }): Promise<AnalyzeResult> {
    if (!sharedBoot)
      throw new Error('useInsightRunner: called before boot')
    const state = await sharedBoot
    return state.runtime.analyze(params as never)
  }

  return { query, analyze, isReady, bootError, bootTimings }
}
