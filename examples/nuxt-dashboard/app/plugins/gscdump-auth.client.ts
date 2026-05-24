// Wires the @gscdump/nuxt layer's auth state by calling `setGscAuth` with the
// partner integration response. Must run `pre` so downstream layer plugins —
// which lazily instantiate `$gscFetch` / `$gscAnalyticsClient` — see the auth
// on first read. Mirrors nuxtseo.com's `pro-gsc/app/plugins/gscdump-auth.client.ts`.

interface Integration {
  configured: boolean
  apiKey: string | null
  apiBase: string
  userId: string | null
  browserAnalyzerEnabled: boolean
}

export default defineNuxtPlugin({
  name: 'gscdump-auth',
  enforce: 'pre',
  async setup() {
    const integration = ref<Integration | null>(null)

    async function refresh(): Promise<void> {
      integration.value = await $fetch<Integration>('/api/integration').catch(() => null)
    }

    setGscAuth(() => {
      const g = integration.value
      return {
        apiKey: g?.apiKey ?? null,
        apiBase: g?.apiBase ?? '',
        browserAnalyzerEnabled: !!g?.browserAnalyzerEnabled,
        userId: g?.userId ?? null,
      }
    })

    await refresh()
  },
})
