// Layer-wide DI: analytics context, query dispatcher, fetch instance, and
// analytics client. Hosts override any provide via a later plugin (Nuxt
// picks the last provider).

import type { AnalyticsFetch } from '@gscdump/sdk'
import { createAnalyticsClient } from '@gscdump/sdk'
import { createDefaultGscQueryDispatcher } from '../composables/_useGscQueryDispatcher'
import { createGscAnalyticsContext } from '../composables/useGscAnalytics'
import { useGscAnalyticsConfig } from '../composables/useGscAnalyticsConfig'
import { resolveGscAuthHeaders } from '../composables/useGscAuth'
import { createGscFetch } from '../utils/gsc-fetch'

export default defineNuxtPlugin(() => {
  const cfg = useGscAnalyticsConfig()
  const gscFetch = createGscFetch(cfg.apiBase, cfg.toastErrors)
  const gscAnalyticsClient = createAnalyticsClient({
    apiBase: cfg.apiBase || '',
    fetch: gscFetch as unknown as AnalyticsFetch,
    headers: () => new Headers(resolveGscAuthHeaders()),
  })

  return {
    provide: {
      gscAnalytics: createGscAnalyticsContext(),
      gscQueryDispatcher: createDefaultGscQueryDispatcher(),
      gscFetch,
      gscAnalyticsClient,
    },
  }
})
