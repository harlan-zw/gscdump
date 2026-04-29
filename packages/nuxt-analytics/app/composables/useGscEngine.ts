// App-wide engine override for `useGscQuery`. Replaces nuxtseo's
// `useProBrowserAnalyzerFlag()` with a generic version backed by `useState`
// so the value is SSR-safe and shared across the page tree.
//
// Resolution priority inside `useGscQuery`:
//   per-call `opts.engine` → `useGscEngine().value` → `runtimeConfig.public.
//   analytics.defaultEngine` → `'auto'`.
//
// Set the value once on the consumer side (e.g. from your auth plugin's
// `onReady` hook reading a per-user feature flag) and every query inherits.

import type { GscQueryEngine } from './useGscQuery'

const STATE_KEY = 'gscdump:engine'

export function useGscEngine(): Ref<GscQueryEngine | null> {
  return useState<GscQueryEngine | null>(STATE_KEY, () => null)
}

/** Internal — called by `useGscQuery` to resolve the active default. */
export function resolveDefaultEngine(): GscQueryEngine {
  const override = useGscEngine().value
  if (override)
    return override
  const cfg = useRuntimeConfig().public.analytics as { defaultEngine?: GscQueryEngine } | undefined
  return cfg?.defaultEngine ?? 'auto'
}
