# Release readiness

Last updated: 2026-09-10

Published line: **`3.5.x`**. Hosted API wire version: **`1.0`**.

This file tracks release checks and remaining consumer migrations.
Package version and hosted wire version are separate contracts.

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

## Package release checks

1. Run `pnpm check:release` after installing Chromium.
2. Run `pnpm test:live` with credentials and a Site with recent traffic.
3. Complete a fresh Desktop OAuth login, including `--no-browser` when forwarding a local port.
4. Merge the reviewed PR after the required `test` check passes.
5. Create the release tag from main. The release workflow repeats package and runtime checks before publishing.

The packaged CLI check uses an isolated installation and a temporary Store.
MCP discovery includes only Reports with usable live Sections.
The Nuxt example and hosted deployment migrations have separate validation.

## Consumer migration gates

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

2026-07-20 status: both consumers are code-migrated to package-owned GSC and
hosted-client seams (deployment + census still pending). Existing hosted wire
operations for permission recovery, URL inspection, canonical mismatches,
sitemaps, teams/catalog, site-ID crosswalk, verification, bulk analytics, and
query-dimension sources now have official typed descriptors and SDK methods.
The six legacy partner analyses with zero consumers anywhere (contentVelocity,
ctrCurve, darkTraffic, deviceGap, keywordBreadth, positionDistribution) were
deleted from contracts and `PartnerClient`; the gscdump.com session routes for
those analyses remain host-private. Arbitrary SQL, browser/session/admin,
provisioning, enrichment, and other host-specific workflows stay deliberately
outside the portable SDK. Their deployed legacy routes remain until telemetry
shows zero use or a separately owned migration defines their replacement.

### Legacy storage decommission (D4)

Keep bespoke-parquet GC and the Node-only Iceberg overwrite/delete recovery
surface until the old bucket/catalog data has been migrated or deleted and the
consumer recovery script no longer imports `@gscdump/engine/sink-node`.

### Nuxt reference example

Resolved 2026-07-20 by relabeling: `examples/nuxt-dashboard` is a limited
integration example, not a v1 reference. Its README states the local
`layers/gsc` stub is intentionally not a published contract.
`nuxtseo.com/layers/pro/gsc` is the production consumer reference; porting that
full layer into the example remains optional future work. Do not delete the
example layer while the example extends it.

### Live Google verification

Run `pnpm test:live` with `GSC_ACCESS_TOKEN`, or with
`GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` + `GSC_REFRESH_TOKEN`, before release.
Set `GSC_SITE_URL` to target a Site with recent traffic.
The command fails without credentials or pipeline data.

## Completion bar

Package delivery needs passing build, typecheck, unit, packed-install, browser, and Workers checks.
Live Google verification must exercise data rather than skip.

Hosted cutover and legacy storage removal need their consumer deployment evidence before those changes ship.
The July consumer notes above remain the last recorded deployment status.
They do not prove the current hosted rollout state.
