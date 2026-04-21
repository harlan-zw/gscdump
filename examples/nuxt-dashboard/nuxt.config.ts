// Nuxt 4 config for the gscdump Phase 3 reference dashboard.
// Target: Node dev + deploys to CF Pages or Node. DuckDB-WASM lives client-only.

import process from 'node:process'

export default defineNuxtConfig({
  future: { compatibilityVersion: 4 },
  runtimeConfig: {
    // Set GSCDUMP_DATA_DIR (e.g. ~/.gscdump/data) to serve from a local
    // `gscdump sync` dump instead of R2. R2 vars ignored when this is set.
    gscDataDir: process.env.GSCDUMP_DATA_DIR ?? '',
    r2AccountId: process.env.R2_ACCOUNT_ID ?? '',
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    r2Bucket: process.env.R2_BUCKET ?? '',
    gscUserId: process.env.GSCDUMP_USER_ID ?? '',
    gscSiteId: process.env.GSCDUMP_SITE_ID ?? '',
    public: {
      // Re-used by useRuntimeConfig() on the client — the manifest + sign-url
      // routes are same-origin so the client never needs R2 creds directly.
      defaultUserId: process.env.GSCDUMP_USER_ID ?? '',
      defaultSiteId: process.env.GSCDUMP_SITE_ID ?? '',
    },
  },
  vite: {
    optimizeDeps: {
      // DuckDB-WASM workers pull through esm.sh-style URL imports that Vite's
      // prebundler doesn't understand. Force them out of optimizeDeps so they
      // stream as-is in dev.
      exclude: ['@duckdb/duckdb-wasm'],
    },
  },
  nitro: {
    experimental: {
      tasks: false,
    },
  },
  ssr: true,
  devtools: { enabled: false },
  typescript: { strict: true },
})
