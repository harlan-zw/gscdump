# v1 closeout

Last updated: 2026-07-19

Working line: **`0.39.x`**. This file lists only work that still gates v1 or
the deletion of a compatibility surface. Shipped work belongs in tests, ADRs,
release notes, and git history.

## Package set

- `gscdump`
- `@gscdump/contracts`
- `@gscdump/engine`
- `@gscdump/engine-duckdb-wasm`
- `@gscdump/engine-gsc-api`
- `@gscdump/engine-sqlite`
- `@gscdump/analysis`
- `@gscdump/lakehouse`
- `@gscdump/cloudflare`
- `@gscdump/sdk`
- `@gscdump/cli` (including `gscdump mcp`)

`@gscdump/nuxt` and `@gscdump/mcp` were deleted. Nuxt integration is owned by
consumer layers, and the MCP server is owned by the CLI.

## Open gates

### Hosted v1 cutover

The descriptor-driven HTTP client and ticketed realtime client ship on
`@gscdump/sdk/v1`. Keep the legacy partner HTTP routes/client until:

1. `nuxtseo.com` is deployed on the v1 operations it can consume;
2. remaining private operations are either promoted to v1 or documented as
   host-private exceptions; and
3. deployed route telemetry shows zero legacy use for the agreed census
   window.

Do not infer this gate from repository references alone. See ADR-0011 and the
consumer rollout records.

### Legacy storage decommission (D4)

Keep bespoke-parquet GC and the Node-only Iceberg overwrite/delete recovery
surface until the old bucket/catalog data has been migrated or deleted and the
consumer recovery script no longer imports `@gscdump/engine/sink-node`.

### Nuxt reference example

`examples/nuxt-dashboard` builds, but its local `layers/gsc` is explicitly a
stub copied from the former package. Before calling it a v1 reference, either
port the current `nuxtseo.com/layers/pro/gsc` seams or relabel it as a limited
integration example. Do not delete the layer while the example extends it.

### Live Google verification

Run `pnpm test:e2e` with `GSC_ACCESS_TOKEN`, or with
`GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` + `GSC_REFRESH_TOKEN`, before the v1 tag.
Credential-free local runs intentionally skip live Google assertions.

## Completion bar

V1 is ready when package build/typecheck/tests pass, consumer migrations and
their focused tests pass, live Google e2e has run with credentials, and every
remaining compatibility surface above has an explicit owner and deletion
gate. No new 0.x compatibility aliases should be added.
