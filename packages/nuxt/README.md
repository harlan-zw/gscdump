# @gscdump/nuxt

[![npm version](https://img.shields.io/npm/v/@gscdump/nuxt?color=yellow)](https://npmjs.com/package/@gscdump/nuxt)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/nuxt?color=yellow)](https://npm.chart.dev/@gscdump/nuxt)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Nuxt layer: GSC analytics UI, Nuxt auth/runtime wiring, and DuckDB-WASM integration. It uses `@gscdump/sdk` internally for hosted analytics HTTP reads.

This package assumes a site is already linked. It does not own partner
onboarding, registration, lifecycle decisions, token exchange, or webhook
subscription management. Use `@gscdump/sdk` from the host app for those
flows, then pass the linked `gscdumpSiteId` into the analytics composables
here.

Three consumption modes:

| Mode | Who | What it does |
| --- | --- | --- |
| `origin` | gscdump.com | Reads R2 data directly (binding) + DuckDB service binding. Owns the data. |
| `consumer` | nuxtseo.com | Proxies all reads to an origin over HTTP + an API key. No data locally. |
| `local` | `examples/nuxt-dashboard` | Reads a `gscdump sync` dump from `GSCDUMP_DATA_DIR`. Offline dev. |

## Install

```bash
pnpm add @gscdump/nuxt
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: ['@gscdump/nuxt'],
  runtimeConfig: {
    public: {
      analytics: {
        apiBase: '', // same-origin by default; set to your analytics origin in consumer mode
      },
    },
  },
})
```

Nuxt auto-imports the layer composables. If you prefer explicit imports, use
per-composable entrypoints:

```ts
import { setGscAuth } from '@gscdump/nuxt/composables/useGscAuth'
import { useGscRollup } from '@gscdump/nuxt/composables/useGscRollup'
```

The primary query interface is `useGscQuery` / `useGscAnalyzer`.

## Register an auth provider

```ts
// server/plugins/register-auth.ts
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('analytics:register-auth-provider', (register) => {
    register({
      resolve: async (event) => {
        const session = await getUserSession(event)
        if (!session)
          return null
        return { userId: session.user.id, siteIds: session.accessibleSiteIds }
      },
    })
  })
})
```

## Data access: which endpoint?

| Need | Endpoint | Client composable |
| --- | --- | --- |
| Pre-aggregated widgets (top pages, daily totals) | `GET /api/__gsc/sites/:siteId/rollup/:id` | `useGscRollup` / `useGscRollups` / `useGscRollupFanout` |
| Raw rows filtered by dimension/range (`where(eq(page, ...))`) | `POST /api/__gsc/sites/:siteId/rows` | `useGscQuery({ siteId, params })` |
| Analyzer result (striking-distance, CTR anomaly, …) | `POST /api/__gsc/sites/:siteId/analyze` | `useGscAnalyzer(siteId).analyze(...)` |

Rule of thumb: reach for `/rows` + `useGscQuery` for detail pages that
need a freeform slice of the data. Only fall back to `/analyze` when the
server runs an actual analyzer (anything in the registry); hitting it for
plain row lookups routes through analyzer-gating logic you don't need.

## Consumer mode (cross-origin)

Used when the Nuxt app authenticating the viewer is not the same origin as
the data — e.g. nuxtseo.com pro consuming gscdump.com. Two pieces:

1. **Point fetch at the origin**: set `runtimeConfig.public.analytics.apiBase`
   in `nuxt.config.ts` (or via `NUXT_PUBLIC_ANALYTICS_API_BASE`). Empty =
   same-origin (the default origin-mode shape).

2. **Hand the layer per-viewer auth**: register a client plugin that trades
   the viewer's host session for an api key, then call
   `setGscAuth({ apiKey: key })`. The layer's `useGscFetch`
   attaches the header to every `/api/__gsc/*` call automatically. Browser
   parquet reads use exact-object URLs minted by the source endpoint; runtime
   preflights can include this header, while DuckDB-WASM range reads are
   authorized by the token embedded in each URL.

Wire it from a `'pre'`-enforced client plugin so downstream layer plugins see
the auth on first read. The layer's `setGscAuth` accepts a value, a `Ref`,
or a getter — use a getter when credentials may refresh during the session:

```ts
// plugins/00.gscdump-auth.client.ts
export default defineNuxtPlugin({
  name: 'gscdump-auth',
  enforce: 'pre',
  async setup() {
    const creds = ref<{ apiKey: string, browserAnalyzerEnabled?: boolean } | null>(null)
    creds.value = await $fetch('/api/me/gscdump-credentials').catch(() => null)
    setGscAuth(() => ({
      apiKey: creds.value?.apiKey ?? null,
      browserAnalyzerEnabled: !!creds.value?.browserAnalyzerEnabled,
    }))
  },
})
```

`useGscQuery` mounts that race the credential fetch resolve once the
`'pre'` plugin's `await` settles — Nuxt blocks subsequent plugins on it.

Onboarding and lifecycle state stay outside this layer. A consumer app should
use `@gscdump/sdk` from its host backend to register users/sites, read
`GET /api/partner/users/:userId/lifecycle`, handle webhook or realtime
invalidation, and decide when a linked site is ready to render. Once it has a
linked site id, this layer handles query reads and analytics UI only.

### CORS

The origin app (`gscdump.com` or your own) must allow the consumer origin
on `/api/__gsc/*`, `/api/r2-data/*`, and any host endpoints the helper
calls. Allow-headers must include `x-api-key`, `Cache-Control`, and `Range`
(DuckDB-WASM uses partial reads); expose `Content-Range`, `Accept-Ranges`,
`Content-Length`. Preflight needs to cover `PATCH` for any settings calls.

## Related

- [`@gscdump/sdk`](../sdk) — framework-agnostic hosted API client used by host onboarding code and by this Nuxt layer internally.
- [`gscdump`](../gscdump) — local package and query builder.
- [`@gscdump/engine`](../engine) — Storage engine consumed in origin mode.
- [`@gscdump/engine-duckdb-wasm`](../engine-duckdb-wasm) — DuckDB-WASM browser runtime used by client-side widgets.
- [`@gscdump/analysis`](../analysis) — Analyzers powering `/analyze` endpoints.

## License

[MIT](../../LICENSE)
