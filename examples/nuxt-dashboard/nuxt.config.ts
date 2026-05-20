// Nuxt 4 config for the gscdump reference dashboard.
//
// Three layer modes, switched via `GSCDUMP_ANALYTICS_MODE`:
//  - `local`    (default) — client-side DuckDB-WASM reads parquet directly.
//                            No server proxy, no apiBase.
//  - `origin`              — same-origin Nitro hosts the data (R2 + DuckDB).
//                            Empty apiBase; layer's `/api/__gsc/*` resolves
//                            against this host.
//  - `consumer`            — proxies to a remote origin (e.g. gscdump.com).
//                            apiBase defaults to GSCDUMP_ANALYTICS_API_BASE
//                            or `https://gscdump.com`.
//
// Picked at build time so the resulting bundle is mode-stable — flipping
// modes requires a fresh `nuxt dev` / `nuxt build`, which is what each
// `dev:*` script in package.json drives.

import process from 'node:process'

const VALID_MODES = ['local', 'origin', 'consumer'] as const
type AnalyticsMode = typeof VALID_MODES[number]

const rawMode = process.env.GSCDUMP_ANALYTICS_MODE ?? 'local'
if (!VALID_MODES.includes(rawMode as AnalyticsMode))
  throw new Error(`GSCDUMP_ANALYTICS_MODE must be one of ${VALID_MODES.join(', ')} — got "${rawMode}"`)
const mode = rawMode as AnalyticsMode

const apiBase = mode === 'consumer'
  ? (process.env.GSCDUMP_ANALYTICS_API_BASE ?? 'https://gscdump.com')
  : ''

export default defineNuxtConfig({
  future: { compatibilityVersion: 4 },
  extends: ['../../packages/nuxt'],
  gscdumpAnalytics: {
    analyzers: '~/gscAnalyzers',
  },
  runtimeConfig: {
    partner: {
      apiBase: process.env.GSCDUMP_PARTNER_API_BASE ?? (apiBase ? `${apiBase.replace(/\/+$/, '')}/api` : '/api'),
      apiKey: process.env.GSCDUMP_PARTNER_API_KEY ?? '',
      userId: process.env.GSCDUMP_PARTNER_USER_ID ?? '',
    },
    public: {
      analytics: {
        mode,
        apiBase,
        // Auto-toast errors via classifyGscError + useToast (Nuxt UI).
        // Off in `local` mode where there's no remote and toasts would be
        // noise; on for origin/consumer which actually hit a server.
        toastErrors: mode !== 'local',
      },
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
