# Nuxt dashboard example

A Nuxt 4 integration example for the gscdump query, analyzer, hosted SDK, and
browser DuckDB-WASM packages.

The app supports three build-time modes through `GSCDUMP_ANALYTICS_MODE`:

- `local` (default): browser DuckDB-WASM reads the configured data source.
- `origin`: same-origin Nitro routes host analytics access.
- `consumer`: requests a remote hosted origin through
  `GSCDUMP_ANALYTICS_API_BASE`.

The local `layers/gsc` directory is a buildable UI fixture. Stable Nuxt
integration, runtime defaults and analyzer registration, comes from
`@gscdump/nuxt`. Consumer applications continue to own views, authentication,
routes, and product fallback policy.

## Run

```sh
pnpm --filter @gscdump/example-nuxt-dashboard dev:local
```

For hosted partner pages, set:

```sh
GSCDUMP_PARTNER_API_BASE=https://gscdump.com/api
GSCDUMP_PARTNER_API_KEY=...
GSCDUMP_PARTNER_USER_ID=...
```

Use `dev:origin` or `dev:consumer` for the other modes. See
`nuxt.config.ts` and `.env.example` for the complete configuration surface.

## V1 status

The example is a regression fixture. Its local components and composables are
examples, not a shared UI contract.
