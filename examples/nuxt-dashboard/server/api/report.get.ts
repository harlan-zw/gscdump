// Server-side action-priority digest. Runs the same five analyzers the
// browser's Actions tab runs, but entirely on the server using the existing
// Node DuckDB engine. Suitable for scheduled reports (cron, queue worker,
// email job): same data path as the WASM dashboard, no browser required.
//
// Returns the raw `analyzeActionPriority` result plus per-source statuses
// and timings so the frontend can render an honest preview.

import type { ActionPrioritySourceState } from '@gscdump/analysis'
import { analyzeActionPriority, defaultAnalyzerRegistry, runAnalyzerWithEngine } from '@gscdump/analysis'
import { useAnalysisEngine } from '../utils/analysis-engine'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const limit = query.limit !== undefined ? Number(query.limit) : 40

  const origin = getRequestURL(event).origin

  const t0 = performance.now()
  const { engine, ctx } = await useAnalysisEngine(origin)
  const setupMs = performance.now() - t0

  const sourceStates: ActionPrioritySourceState[] = []

  // Serialize analyzer execution: the Node DuckDB handle is a process-wide
  // singleton, and the executor's registerFileBuffer/dropFiles dance races
  // when SQL analyzers run concurrently (one analyzer's drop can unregister
  // a key another is mid-query on). analyzeActionPriority uses Promise.all
  // internally; this mutex flattens that to one-at-a-time.
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => undefined)
    return next
  }

  const t1 = performance.now()
  const result = await analyzeActionPriority(
    {
      analyze: params => serialized(() => runAnalyzerWithEngine({ engine }, ctx, params, defaultAnalyzerRegistry)),
    },
    {
      limit,
      onSourceStatus: (state) => {
        const idx = sourceStates.findIndex(s => s.source === state.source)
        if (idx >= 0)
          sourceStates[idx] = state
        else
          sourceStates.push(state)
      },
    },
  )
  const analyzeMs = performance.now() - t1

  return {
    actions: result.actions,
    totalSignals: result.totalSignals,
    sources: result.sources,
    generatedAt: new Date().toISOString(),
    timings: {
      setupMs,
      analyzeMs,
      totalMs: setupMs + analyzeMs,
    },
  }
})
