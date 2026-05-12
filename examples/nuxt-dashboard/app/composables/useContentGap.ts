import type {
  ContentGapOptions,
  ContentGapProgress,
  ContentGapResult,
} from '@gscdump/analysis/semantic'
import type { QueryResult } from '@gscdump/engine-duckdb-wasm'

import { analyzeContentGap } from '@gscdump/analysis/semantic'
import { pgResolverAdapter } from '@gscdump/engine/resolver'
import { createSqlQuerySource } from '@gscdump/engine/source'

export type { ContentGapOptions, ContentGapProgress, ContentGapResult }

interface AnalysisRunner {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
}

export interface ContentGapRunner {
  progress: Ref<ContentGapProgress>
  results: Ref<ContentGapResult[]>
  error: Ref<Error | null>
  running: Ref<boolean>
  run: (runner: AnalysisRunner, opts?: ContentGapOptions) => Promise<void>
}

export function useContentGap(): ContentGapRunner {
  // `useState` so panel switches preserve the long-running embedding job
  // state across tab unmounts.
  const progress = useState<ContentGapProgress>('gscContentGap:progress', () => ({
    phase: 'idle',
    message: 'Ready. First run downloads ~110MB Xenova/bge-base-en-v1.5; cached thereafter. Re-runs skip embedding via IndexedDB cache.',
  }))
  const results = useState<ContentGapResult[]>('gscContentGap:results', () => [])
  const error = useState<Error | null>('gscContentGap:error', () => null)
  const running = useState<boolean>('gscContentGap:running', () => false)

  async function run(runner: AnalysisRunner, opts: ContentGapOptions = {}): Promise<void> {
    if (running.value)
      return

    running.value = true
    error.value = null
    results.value = []

    const source = createSqlQuerySource({
      name: 'browser',
      adapter: pgResolverAdapter,
      execute: async (sql, params) => {
        const result = await runner.query(sql, params)
        return result.rows
      },
    })

    try {
      const analysis = await analyzeContentGap(source, {
        ...opts,
        onProgress(next) {
          progress.value = next
          opts.onProgress?.(next)
        },
      })
      results.value = analysis.results
    }
    catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      progress.value = { phase: 'error', message: error.value.message }
    }
    finally {
      running.value = false
    }
  }

  return { progress, results, error, running, run }
}
