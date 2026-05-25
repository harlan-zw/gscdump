import type { UseNuxtRpcOptions } from 'nuxt-use-query/rpc'
import { useNuxtRpc } from 'nuxt-use-query/rpc'
import { useGscFetch } from './gsc-fetch'

export function useGscRpc(options: UseNuxtRpcOptions = {}): ReturnType<typeof useNuxtRpc> {
  return useNuxtRpc({
    ...options,
    fetch: options.fetch ?? (useGscFetch() as UseNuxtRpcOptions['fetch']),
  })
}
