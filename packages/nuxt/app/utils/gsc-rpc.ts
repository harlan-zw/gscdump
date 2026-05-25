import type { NuxtRpcErrorEvent, UseNuxtRpcOptions } from 'nuxt-use-query/rpc'
import { toHumanNuxtRpcError, useNuxtRpc } from 'nuxt-use-query/rpc'
import { useGscFetch } from './gsc-fetch'

// Layer-shared RPC executor. Routes through `useGscFetch()` so auth headers and
// the configured `apiBase` (cross-origin gscdump.com deployments) are honoured.
// Defaults `onError` to log a humanised message via `toHumanNuxtRpcError`; the
// toast is already emitted by `useGscFetch`'s `onResponseError`, so this is
// non-duplicate diagnostic output that hosts can override.
export function useGscRpc(options: UseNuxtRpcOptions = {}): ReturnType<typeof useNuxtRpc> {
  return useNuxtRpc({
    ...options,
    fetch: options.fetch ?? (useGscFetch() as UseNuxtRpcOptions['fetch']),
    onError: options.onError ?? ((event: NuxtRpcErrorEvent) => {
      console.warn(`[gsc-rpc] ${event.operation.method} ${event.operation.path}: ${toHumanNuxtRpcError(event.error)}`)
    }),
  })
}
