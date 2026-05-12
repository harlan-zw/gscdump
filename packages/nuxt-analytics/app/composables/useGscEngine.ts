// App-wide engine override for `useGscQuery`. SSR-safe via `useState`.
//
// Resolution priority lives in `useGscQueryDispatcher.pickEngine`:
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
