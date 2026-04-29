// Nuxt module for @gscdump/nuxt-analytics.
//
// Responsibilities:
//  - Merge the layer's public runtime-config defaults (apiBase, duckdbBundleBase)
//    with env-var fallbacks. The layer is a portable client; hosts pick where
//    `/api/__gsc/*` calls go via `GSCDUMP_ANALYTICS_API_BASE`.
//
// Auth-provider wiring is NOT a Nuxt module hook; the host wires its own
// Nitro server handlers using primitives from @gscdump/cloudflare,
// @gscdump/engine-sqlite, and @gscdump/analysis. Using a build-time hook
// here would fire before the host's plugin has a chance to register.

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
        timezone: process.env.GSCDUMP_ANALYTICS_TIMEZONE ?? '',
        toastErrors: process.env.GSCDUMP_ANALYTICS_TOAST_ERRORS === 'true',
        defaultEngine: (process.env.GSCDUMP_ANALYTICS_DEFAULT_ENGINE as 'auto' | 'browser' | 'server' | undefined) ?? 'auto',
      },
    )
  },
})
