# Nuxt dashboard example

A Nuxt 4 integration example for the gscdump query, analyzer, hosted SDK, and
browser DuckDB-WASM packages.

The app supports three build-time modes through `GSCDUMP_ANALYTICS_MODE`:

- `local` (default): browser DuckDB-WASM reads the configured data source.
- `origin`: same-origin Nitro routes host analytics access.
- `consumer`: requests a remote hosted origin through
  `GSCDUMP_ANALYTICS_API_BASE`.

The local `layers/gsc` directory contains example UI and an Analyzer plugin.
Your application owns its authentication, routes, and fallback behavior.

## Run

Run from the repository root with Node.js 22 or newer:

```sh
pnpm install
pnpm build
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

## Integration scope

The example exercises package integration and includes legacy hosted routes.
For a new hosted application, follow the [v1 integration guide](../../docs/guides/hosted-v1.md).
Components and composables under `layers/gsc` belong to this example.
