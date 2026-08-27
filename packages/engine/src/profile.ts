/**
 * Query profiling primitive — an injected timing sink for the read path.
 *
 * The read path has three distinct cost centres that a single wall-clock
 * number hides: the manifest lookup (`manifest.list`), the file fetch +
 * vFS registration (`files.register`), and the SQL execution (`query.run`).
 * Deciding whether, say, the buffer-path's serial file reads actually cost
 * anything needs those broken apart — measured, not guessed.
 *
 * This stays an INJECTED dependency, never a global: a caller that wants
 * numbers passes a `QueryProfiler` on the `QueryCtx`/`RunSQLOptions`; a
 * caller that doesn't pays nothing (every emit site is `profiler?.start(...)`,
 * so an absent profiler is a single optional-chain skip). Edge-safe: the
 * default clock is `Date.now`, no node builtins, no import-time state.
 *
 * Spans nest by emit order, not by a tree structure — `executor.execute`
 * wraps `files.register` + `query.run`, `manifest.list` precedes it. The sink
 * receives a flat stream; the caller reconstructs nesting from names if it
 * cares.
 */

import type { QueryProfiler, QuerySpan } from './storage'

export type { QueryProfiler, QuerySpan } from './storage'

/**
 * Build a {@link QueryProfiler} that records each closed span to `sink`.
 *
 * `start(name, meta)` stamps the open time and returns an `end` thunk; calling
 * `end(extra)` records `{ name, ms, meta }` with `extra` merged over the
 * open-time `meta` (so completion-only facts — row counts, buffered-file
 * counts — land on the same span). `now` is injectable for deterministic
 * tests; it defaults to `Date.now`.
 */
export function createQueryProfiler(
  sink: (span: QuerySpan) => void,
  now: () => number = () => Date.now(),
): QueryProfiler {
  return {
    start(name, meta) {
      const t0 = now()
      return (extra) => {
        const merged = meta || extra ? { ...meta, ...extra } : undefined
        sink(merged ? { name, ms: now() - t0, meta: merged } : { name, ms: now() - t0 })
      }
    },
  }
}

/**
 * A profiler that accumulates closed spans into an array — for tests, the CLI
 * `query` command, or any ad-hoc "where did the time go" probe. The returned
 * `spans` array is filled as spans close, in completion order.
 */
export function collectSpans(now?: () => number): { profiler: QueryProfiler, spans: QuerySpan[] } {
  const spans: QuerySpan[] = []
  return { profiler: createQueryProfiler(s => spans.push(s), now), spans }
}
