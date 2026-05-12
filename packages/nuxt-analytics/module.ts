// Nuxt module for @gscdump/nuxt-analytics.
//
// Responsibilities:
//  - Merge the layer's public runtime-config defaults (apiBase, duckdbBundleBase)
//    with env-var fallbacks. The layer is a portable client; hosts pick where
//    `/api/__gsc/*` calls go via `GSCDUMP_ANALYTICS_API_BASE`.
//  - Generate the `$gscAnalyzers` plugin from `options.analyzers` so hosts
//    only declare their analyzer registry path in `nuxt.config.ts` — no
//    plugin boilerplate.
//
// Auth-provider wiring is NOT a Nuxt module hook; the host wires its own
// Nitro server handlers using primitives from @gscdump/cloudflare,
// @gscdump/engine-sqlite, and @gscdump/analysis. Using a build-time hook
// here would fire before the host's plugin has a chance to register.

import type { GscAnalyticsRuntimeConfig } from './types'
import process from 'node:process'
import { addPluginTemplate, defineNuxtModule } from '@nuxt/kit'
import { defu } from 'defu'

export interface ModuleOptions {
  /**
   * Path to a TS/JS file exporting `ANALYZERS` (a `GscAnalyzerDefinition[]`).
   * Accepts Nuxt aliases (`~/gscAnalyzers`) or absolute paths. When set, the
   * module generates a plugin that provides `$gscAnalyzers` so hosts do not
   * need to hand-roll their own plugin file.
   */
  analyzers?: string
}

declare module 'nuxt/schema' {
  interface NuxtConfig { gscdumpAnalytics?: ModuleOptions }
  interface NuxtOptions { gscdumpAnalytics: ModuleOptions }
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@gscdump/nuxt-analytics',
    configKey: 'gscdumpAnalytics',
    compatibility: { nuxt: '>=4.0.0' },
  },
  setup(options, nuxt) {
    const defaults: GscAnalyticsRuntimeConfig = {
      apiBase: process.env.GSCDUMP_ANALYTICS_API_BASE ?? '',
      duckdbBundleBase: process.env.GSCDUMP_DUCKDB_BUNDLE_BASE ?? '',
      timezone: process.env.GSCDUMP_ANALYTICS_TIMEZONE ?? '',
      toastErrors: process.env.GSCDUMP_ANALYTICS_TOAST_ERRORS === 'true',
      defaultEngine: (process.env.GSCDUMP_ANALYTICS_DEFAULT_ENGINE as GscAnalyticsRuntimeConfig['defaultEngine'] | undefined) ?? 'auto',
    }
    nuxt.options.runtimeConfig.public.analytics = defu(
      nuxt.options.runtimeConfig.public.analytics as Partial<GscAnalyticsRuntimeConfig> | undefined,
      defaults,
    )

    if (options.analyzers) {
      // Generated plugin imports the host's analyzer file and provides
      // `$gscAnalyzers`. Runs after the layer's `analytics.ts` plugin (which
      // doesn't provide `$gscAnalyzers`), so consumers see this array.
      addPluginTemplate({
        filename: 'gscdump-analyzers.plugin.mjs',
        getContents: () => [
          `import { defineNuxtPlugin } from '#app'`,
          `import { ANALYZERS } from ${JSON.stringify(options.analyzers)}`,
          `export default defineNuxtPlugin(() => ({ provide: { gscAnalyzers: ANALYZERS } }))`,
          ``,
        ].join('\n'),
      })
    }

    // Strip underscore-prefixed composables from the consumer auto-import surface.
    // `app/composables/_useFoo.ts` stays usable inside the layer via explicit
    // relative imports, but never appears as a global auto-import in host apps.
    nuxt.hook('imports:extend', (imports) => {
      for (let i = imports.length - 1; i >= 0; i--) {
        const from = imports[i]?.from ?? ''
        if (/\/_use[A-Z]/.test(from))
          imports.splice(i, 1)
      }
    })
  },
})
