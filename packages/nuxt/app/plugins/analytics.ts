// Layer-wide DI: analytics context, query dispatcher, fetch instance, and
// analytics client. Each value is defined as a lazy getter on the NuxtApp so
// non-GSC routes pay zero cost and host plugins (e.g. route-gated setGscAuth)
// can run before any of these are materialized. Hosts override by reassigning
// the same `$xxx` key from a later plugin (Nuxt's provide uses configurable
// defineProperty, so the last writer wins).

import type { AnalyticsClient, AnalyticsFetch } from '@gscdump/sdk'
import type { $Fetch } from 'ofetch'
import type { GscQueryDispatcher } from '../composables/_useGscQueryDispatcher'
import type { GscAnalyticsContext } from '../composables/useGscAnalytics'
import { createAnalyticsClient } from '@gscdump/sdk'
import { createDefaultGscQueryDispatcher } from '../composables/_useGscQueryDispatcher'
import { createGscAnalyticsContext } from '../composables/useGscAnalytics'
import { useGscAnalyticsConfig } from '../composables/useGscAnalyticsConfig'
import { resolveGscAuthHeaders } from '../composables/useGscAuth'
import { createGscFetch } from '../utils/gsc-fetch'

export default defineNuxtPlugin((nuxtApp) => {
  let _ctx: GscAnalyticsContext | undefined
  let _dispatcher: GscQueryDispatcher | undefined
  let _fetch: $Fetch | undefined
  let _client: AnalyticsClient | undefined

  function getFetch(): $Fetch {
    if (!_fetch) {
      const cfg = useGscAnalyticsConfig()
      _fetch = createGscFetch(cfg.apiBase, cfg.toastErrors)
    }
    return _fetch
  }

  const lazy: Record<string, () => unknown> = {
    $gscAnalytics: () => _ctx ??= createGscAnalyticsContext(),
    $gscQueryDispatcher: () => _dispatcher ??= createDefaultGscQueryDispatcher(),
    $gscFetch: () => getFetch(),
    $gscAnalyticsClient: () => {
      if (!_client) {
        const cfg = useGscAnalyticsConfig()
        _client = createAnalyticsClient({
          apiBase: cfg.apiBase || '',
          fetch: getFetch() as unknown as AnalyticsFetch,
          headers: () => new Headers(resolveGscAuthHeaders()),
        })
      }
      return _client
    },
  }

  for (const [key, factory] of Object.entries(lazy)) {
    Object.defineProperty(nuxtApp, key, {
      get: factory,
      configurable: true,
      enumerable: true,
    })
  }
})
