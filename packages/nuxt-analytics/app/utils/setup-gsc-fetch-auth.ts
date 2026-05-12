// Plugin factory for consumer-mode auth wiring.
//
// In consumer mode, the host app authenticates the viewer against its own
// origin and exchanges that for a gscdump.com api key. `setupGscFetchAuth`
// collapses the boilerplate of "fetch credentials, call setGscAuth, dedupe
// via inflight promise, enforce: 'pre'" into a single call. The returned
// value is a plugin definition; consumers re-export it from a client plugin
// file (`plugins/00.gscdump-auth.client.ts`).
//
// `enforce: 'pre'` + the returned promise make Nuxt block subsequent plugins
// until headers land, which avoids the auth-header race where a query mounts
// before credentials resolve.

import { setGscAuth } from '../composables/useGscAuth'

interface SetupGscFetchAuthOptions<TCreds extends Record<string, any> = { apiKey: string }> {
  /** Host endpoint returning credentials. Called once per page load. */
  credentialsEndpoint: string
  /** Field on the response holding the api key. Default: `apiKey`. */
  tokenField?: keyof TCreds & string
  /** Header name to send to gscdump.com. Default: `x-api-key`. Set this only when the host uses a custom header name; the layer maps `apiKey` → `x-api-key` by default. */
  headerName?: string
  /**
   * Optional hook fired after auth is set. Use for host-specific state
   * preloading (e.g. user settings flags). Runs inside `nuxtApp.runWithContext`.
   */
  onReady?: (ctx: { credentials: TCreds }) => void | Promise<void>
}

export function setupGscFetchAuth<TCreds extends Record<string, any> = { apiKey: string }>(
  options: SetupGscFetchAuthOptions<TCreds>,
): ReturnType<typeof defineNuxtPlugin> {
  const { credentialsEndpoint, tokenField = 'apiKey' as keyof TCreds & string, headerName = 'x-api-key', onReady } = options
  let inflight: Promise<void> | null = null

  return defineNuxtPlugin({
    name: 'gscdump-analytics-auth',
    enforce: 'pre',
    async setup(nuxtApp) {
      if (inflight)
        return inflight
      inflight = (async () => {
        const credentials = await $fetch<TCreds>(credentialsEndpoint).catch(() => null)
        const apiKey = credentials?.[tokenField] as string | undefined
        if (!apiKey)
          return
        // Default header name = `x-api-key` is already handled by the layer
        // when `apiKey` is set on auth state. A custom `headerName` is routed
        // through the opaque `headers` bag.
        setGscAuth({
          apiKey: headerName === 'x-api-key' ? apiKey : null,
          browserAnalyzerEnabled: false,
          headers: headerName === 'x-api-key' ? undefined : { [headerName]: apiKey },
        })
        if (onReady) {
          await nuxtApp.runWithContext(() => onReady({ credentials: credentials! }))
        }
      })()
      return inflight
    },
  })
}
