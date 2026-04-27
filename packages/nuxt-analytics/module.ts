// Nuxt module for @gscdump/nuxt-analytics.
//
// Responsibilities:
//  - Merge the layer's public runtime-config defaults (apiBase, duckdbBundleBase)
//    with env-var fallbacks. The layer is a portable client; hosts pick where
//    `/api/__gsc/*` calls go via `GSCDUMP_ANALYTICS_API_BASE`.
//
// Auth-provider wiring is NOT a Nuxt module hook — it's a direct function
// call at Nitro boot. See server/utils/analytics/auth.ts for the contract.
// Using a hook here would fire at build time, before the host's plugin has
// a chance to register.

import process from 'node:process'
import { defineNuxtModule } from '@nuxt/kit'
import { defu } from 'defu'

export default defineNuxtModule({
  meta: {
    name: '@gscdump/nuxt-analytics',
    configKey: 'gscdumpAnalytics',
    compatibility: { nuxt: '>=4.0.0' },
  },
  setup(_options, nuxt) {
    nuxt.options.runtimeConfig.public.analytics = defu(
      (nuxt.options.runtimeConfig.public.analytics as Record<string, unknown> | undefined),
      {
        duckdbBundleBase: process.env.GSCDUMP_DUCKDB_BUNDLE_BASE ?? '',
        apiBase: process.env.GSCDUMP_ANALYTICS_API_BASE ?? '',
      },
    )
  },
})
