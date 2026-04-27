// Plugin factory for consumer-mode auth wiring.
//
// In consumer mode, the host app authenticates the viewer against its own
// origin and exchanges that for a gscdump.com api key. Every host then
// hand-rolls the same plugin: fetch credentials, call setGscFetchHeaders,
// optionally preload extra state, dedupe via inflight promise, enforce: 'pre'.
//
// `setupGscFetchAuth` collapses that boilerplate into a single call. The
// returned value is a plugin definition; consumers re-export it from a
// client plugin file (`plugins/00.gscdump-auth.client.ts`).
//
// `enforce: 'pre'` + the returned promise make Nuxt block subsequent plugins
// until headers land, which avoids the auth-header race where a query mounts
// before credentials resolve.

interface SetupGscFetchAuthOptions<TCreds extends Record<string, any> = { apiKey: string }> {
  /** Host endpoint returning credentials. Called once per page load. */
  credentialsEndpoint: string
  /** Field on the response holding the api key. Default: `apiKey`. */
  tokenField?: keyof TCreds & string
  /** Header name to send to gscdump.com. Default: `x-api-key`. */
  headerName?: string
  /**
   * Optional hook fired after headers are set. Use for host-specific state
   * preloading (e.g. user settings flags read by composables at construction
   * time). Runs inside `nuxtApp.runWithContext` so composables work.
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
        setGscFetchHeaders({ [headerName]: apiKey })
        if (onReady) {
          await nuxtApp.runWithContext(() => onReady({ credentials: credentials! }))
        }
      })()
      return inflight
    },
  })
}
