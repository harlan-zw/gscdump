// Run N analyzers in parallel against a single analyzer runner, with per-id
// status tracking, optional concurrency cap, and stale-token discard so
// late-completing tasks from a superseded `run()` don't overwrite fresher state.
//
// Caller owns: result shaping (summarize, scoring), the trigger watcher,
// and which ids to run.

import type { MaybeRefOrGetter, Ref } from '@vue/runtime-core'

export type GscAnalyzerBatchStatus = 'idle' | 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface GscAnalyzerBatchEntry<TResult> {
  status: GscAnalyzerBatchStatus
  result: TResult | null
  error: Error | null
}

export interface GscAnalyzerBatchRunner {
  analyze: (params: { type: string, startDate?: string, endDate?: string }) => Promise<unknown>
}

export interface UseGscAnalyzerBatchOptions {
  /** Cap parallel analyzer runs. DuckDB-WASM is single-threaded; high parallelism just serializes behind one connection. Default 2. */
  concurrency?: number
  /** Drop ids before running (e.g. analyzers the current source can't serve). Returning `false` marks them `skipped`. */
  filter?: (id: string) => boolean
}

export interface UseGscAnalyzerBatchReturn<TResult> {
  states: Ref<Record<string, GscAnalyzerBatchEntry<TResult>>>
  running: Ref<boolean>
  run: () => Promise<void>
}

export function useGscAnalyzerBatch<TResult = unknown>(
  runner: GscAnalyzerBatchRunner,
  ids: MaybeRefOrGetter<readonly string[]>,
  dateRange: MaybeRefOrGetter<{ start: string, end: string }>,
  opts: UseGscAnalyzerBatchOptions = {},
): UseGscAnalyzerBatchReturn<TResult> {
  const states = ref<Record<string, GscAnalyzerBatchEntry<TResult>>>({}) as Ref<Record<string, GscAnalyzerBatchEntry<TResult>>>
  const running = ref(false)
  let token = 0

  function reset(currentIds: readonly string[]): void {
    const next: Record<string, GscAnalyzerBatchEntry<TResult>> = {}
    for (const id of currentIds)
      next[id] = { status: 'pending', result: null, error: null }
    states.value = next
  }

  async function run(): Promise<void> {
    const myToken = ++token
    const currentIds = toValue(ids)
    const range = toValue(dateRange)
    running.value = true
    reset(currentIds)

    const filter = opts.filter
    const concurrency = Math.max(1, opts.concurrency ?? 2)

    const queue: string[] = []
    for (const id of currentIds) {
      if (filter && !filter(id))
        states.value = { ...states.value, [id]: { status: 'skipped', result: null, error: null } }
      else
        queue.push(id)
    }

    async function runOne(id: string): Promise<void> {
      if (token !== myToken)
        return
      states.value = { ...states.value, [id]: { status: 'running', result: null, error: null } }
      try {
        const result = await runner.analyze({ type: id, startDate: range.start, endDate: range.end })
        if (token !== myToken)
          return
        states.value = { ...states.value, [id]: { status: 'done', result: result as TResult, error: null } }
      }
      catch (err) {
        if (token !== myToken)
          return
        const error = err instanceof Error ? err : new Error(String(err))
        states.value = { ...states.value, [id]: { status: 'error', result: null, error } }
      }
    }

    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        if (token !== myToken)
          return
        const id = queue.shift()
        if (!id)
          break
        await runOne(id)
      }
    })

    await Promise.all(workers)

    if (token === myToken)
      running.value = false
  }

  return { states, running, run }
}
