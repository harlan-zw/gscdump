// Provide/inject seam for analyzer panels. Pipeline panels (those declared
// with `panel.ownsLifecycle: true`) need access to the analyzer runner +
// long-running composable instances so they can fire `analyze`/`query` and
// keep their phase state alive across tab switches.
//
// `/analyze` provides these once; panels inject. Type-only — runtime values
// are the InjectionKey Symbols themselves.

import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'
import type { InjectionKey } from '@vue/runtime-core'

export interface GscPanelRunner {
  /** Positional-form SQL runner — `{ rows, queryMs }`. */
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[], queryMs: number }>
  /** Registry-driven analyzer dispatch over the same per-site DuckDB-WASM runtime. */
  analyze: (params: AnalysisParams, opts?: { signal?: AbortSignal }) => Promise<AnalysisResult & { queryMs: number }>
}

export interface GscPanelRunnerContext {
  runner: GscPanelRunner
  ready: Ref<boolean>
}

export const gscPanelRunnerKey: InjectionKey<GscPanelRunnerContext> = Symbol('gscPanelRunnerKey')

export function useGscPanelRunner(): GscPanelRunnerContext {
  const ctx = inject(gscPanelRunnerKey, null)
  if (!ctx)
    throw new Error('useGscPanelRunner() called outside <GscAnalyzerPanel> context')
  return ctx
}
