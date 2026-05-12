// Provide/inject seam for analyzer panels. Pipeline panels (those declared
// with `panel.ownsLifecycle: true`) need access to the analyzer runner +
// long-running composable instances so they can fire `analyze`/`query` and
// keep their phase state alive across tab switches.
//
// `/analyze` provides these once; panels inject. Type-only — runtime values
// are the InjectionKey Symbols themselves.

import type { InjectionKey } from '@vue/runtime-core'
import type { GscAnalyzerInstance } from './useGscAnalyzer'

export interface GscPanelRunnerContext {
  runner: GscAnalyzerInstance
  ready: Ref<boolean>
}

export const gscPanelRunnerKey: InjectionKey<GscPanelRunnerContext> = Symbol('gscPanelRunnerKey')

export function useGscPanelRunner(): GscPanelRunnerContext {
  const ctx = inject(gscPanelRunnerKey, null)
  if (!ctx)
    throw new Error('useGscPanelRunner() called outside <GscAnalyzerPanel> context')
  return ctx
}
