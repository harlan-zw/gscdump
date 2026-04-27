import type {
  ContentGapOptions,
  ContentGapProgress,
  ContentGapResult,
} from '@gscdump/analysis/semantic'
import type { QueryResult } from '@gscdump/engine-wasm'

import { createBrowserQuerySource } from '@gscdump/analysis'
import { analyzeContentGap } from '@gscdump/analysis/semantic'

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
  const progress = ref<ContentGapProgress>({
    phase: 'idle',
    message: 'Ready. First run downloads ~110MB Xenova/bge-base-en-v1.5; cached thereafter. Re-runs skip embedding via IndexedDB cache.',
  })
  const results = ref<ContentGapResult[]>([])
  const error = ref<Error | null>(null)
  const running = ref(false)

  async function run(runner: AnalysisRunner, opts: ContentGapOptions = {}): Promise<void> {
    if (running.value)
      return

    running.value = true
    error.value = null
    results.value = []

    const source = createBrowserQuerySource({
      runner: {
        async query(sql: string, params?: unknown[]) {
          const result = await runner.query(sql, params)
          return result.rows
        },
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
