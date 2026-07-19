# Nuxt dashboard example

A Nuxt 4 integration example for the gscdump query, analyzer, hosted SDK, and
browser DuckDB-WASM packages.

The app supports three build-time modes through `GSCDUMP_ANALYTICS_MODE`:

- `local` (default): browser DuckDB-WASM reads the configured data source.
- `origin`: same-origin Nitro routes host analytics access.
- `consumer`: requests a remote hosted origin through
  `GSCDUMP_ANALYTICS_API_BASE`.

The local `layers/gsc` directory is intentionally a buildable stub, not a
published `@gscdump/nuxt` package. It keeps the example executable while Nuxt
integration is owned by consumer applications. Do not treat its public
composable/component set as a v1 contract.

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

The example builds as a regression fixture, but its stub layer still has TODO
ports from `nuxtseo.com/layers/pro/gsc`. Before presenting it as the canonical
v1 dashboard, either port those current seams or narrow the example to the
hosted SDK flows it actually demonstrates.
