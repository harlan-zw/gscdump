// Layer-mode Nuxt config for @gscdump/nuxt.
//
// Consuming apps pull this in via `extends: ['@gscdump/nuxt']` in
// their own nuxt.config.ts. Anything declared here is a shared default; hosts
// can override in the normal Nuxt fashion (defu-merged, app config wins).
//
// Contract: the layer assumes every consumer is a Nuxt UI v4 app. We register
// `@nuxt/ui` here and ship the shared main.css so hosts don't have to
// rediscover the setup — components in this layer freely use UButton,
// UPopover, UIcon, etc.

import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  // Register the layer's module so hooks + runtime config land on host apps
  // without them having to wire each module individually.
  //
  // `nuxt-use-query` provides `useNuxtQuery` / `useQueryCache` — TanStack-Query-
  // shaped wrapper over `useFetch`. Composables in this layer fetch through
  // it for SWR + dedup.
  modules: [
    fileURLToPath(new URL('./module.ts', import.meta.url)),
    '@nuxt/ui',
    '@vueuse/nuxt',
    'nuxt-use-query',
  ],

  css: [
    fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url)),
  ],

  // runtimeConfig defaults live in module.ts (single source of truth).

  vite: {
    optimizeDeps: {
      // DuckDB-WASM workers use URL imports Vite's prebundler cannot resolve.
      // Keep them outside optimizeDeps so they stream as-is.
      exclude: ['@duckdb/duckdb-wasm'],
    },
  },
})
