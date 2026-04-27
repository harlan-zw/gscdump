# @gscdump/nuxt-analytics

[![npm version](https://img.shields.io/npm/v/@gscdump/nuxt-analytics?color=yellow)](https://npmjs.com/package/@gscdump/nuxt-analytics)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/nuxt-analytics?color=yellow)](https://npm.chart.dev/@gscdump/nuxt-analytics)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Nuxt layer: GSC analytics UI + server handlers + DuckDB integration. Consumed by gscdump.com (origin mode) and nuxtseo.com (consumer mode).

Three consumption modes:

| Mode | Who | What it does |
| --- | --- | --- |
| `origin` | gscdump.com | Reads R2 data directly (binding) + DuckDB service binding. Owns the data. |
| `consumer` | nuxtseo.com | Proxies all reads to an origin over HTTP + an API key. No data locally. |
| `local` | `examples/nuxt-dashboard` | Reads a `gscdump sync` dump from `GSCDUMP_DATA_DIR`. Offline dev. |

## Install

```bash
pnpm add @gscdump/nuxt-analytics
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: ['@gscdump/nuxt-analytics'],
  runtimeConfig: {
    analytics: {
      mode: 'origin', // or 'consumer' / 'local'
    },
  },
})
```

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
| Pre-aggregated widgets (top pages, daily totals) | `GET /api/sites/:siteId/rollup/:id` | `useGscRollup` / `useGscRollups` / `useGscRollupFanout` |
| Raw rows filtered by dimension/range (`where(eq(page, ...))`) | `POST /api/sites/:siteId/rows` | `useGscRowQuery({ site, state })` |
| Analyzer result (striking-distance, CTR anomaly, …) | `POST /api/sites/:siteId/analyze` | `useGscAnalyzer(siteId).analyze(...)` |

Rule of thumb: reach for `/rows` + `useGscRowQuery` for detail pages that
need a freeform slice of the data. Only fall back to `/analyze` when the
server runs an actual analyzer (anything in the registry); hitting it for
plain row lookups routes through analyzer-gating logic you don't need.

## Consumer mode (cross-origin)

Used when the Nuxt app authenticating the viewer is not the same origin as
the data — e.g. nuxtseo.com pro consuming gscdump.com. Two pieces:

1. **Point fetch at the origin**: set `runtimeConfig.public.analytics.apiBase`
   in `nuxt.config.ts` (or via `NUXT_PUBLIC_ANALYTICS_API_BASE`). Empty =
   same-origin (the default origin-mode shape).

2. **Hand the layer a per-viewer api key**: register a client plugin that
   trades the viewer's host session for an api key, then call
   `setGscFetchHeaders({ 'x-api-key': key })`. The layer's `useGscFetch`
   attaches the header to every `/api/__gsc/*` call automatically. The same
   header rides parquet GETs in `attachParquetUrlTables` (DuckDB-WASM
   browser path), so R2 reads work cross-origin.

The `setupGscFetchAuth` helper collapses the boilerplate:

```ts
// plugins/00.gscdump-auth.client.ts
export default setupGscFetchAuth({
  credentialsEndpoint: '/api/me/gscdump-credentials',
  // Optional: preload host-specific state. Runs inside runWithContext so
  // composables work. Useful for useState-backed flags read by the layer's
  // composables at construction time.
  async onReady() {
    const flag = useState<boolean | null>('app:browser-analyzer-enabled', () => null)
    if (flag.value !== null)
      return
    const settings = await useGscFetch()<{ browserAnalyzerEnabled: boolean }>('/api/user/settings').catch(() => null)
    flag.value = !!settings?.browserAnalyzerEnabled
  },
})
```

The helper is `enforce: 'pre'` and dedupes via an inflight promise; Nuxt
blocks subsequent plugins until headers land, removing the auth-header race
where a `useGscQuery` mounts before credentials resolve.

`credentialsEndpoint` returns `{ apiKey: string, ... }` by default. Override
the field name with `tokenField` and the header name with `headerName`.

### CORS

The origin app (`gscdump.com` or your own) must allow the consumer origin
on `/api/__gsc/*`, `/api/r2-data/*`, and any host endpoints the helper
calls. Allow-headers must include `x-api-key`, `Cache-Control`, and `Range`
(DuckDB-WASM uses partial reads); expose `Content-Range`, `Accept-Ranges`,
`Content-Length`. Preflight needs to cover `PATCH` for any settings calls.

## Related

- [`gscdump`](../gscdump) — REST client + query builder.
- [`@gscdump/engine`](../engine) — Storage engine consumed in origin mode.
- [`@gscdump/engine-wasm`](../engine-wasm) — DuckDB-WASM browser runtime used by client-side widgets.
- [`@gscdump/analysis`](../analysis) — Analyzers powering `/analyze` endpoints.

## License

[MIT](../../LICENSE)
