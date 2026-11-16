# Release readiness

The [AI surface parity brief](docs/work/ai-parity-2026-11.md) defines package and consumer acceptance checks.

Last reviewed: 2026-11-11

Read package manifests and npm dist-tags for release versions. Hosted API wire version: **`1.0`**.

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
- `@gscdump/devframe`

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
Use the dated consumer records below to assess their stated scopes.

## Warehouse release evidence, 2026-11-11

[Release v7.12.1](https://github.com/harlan-zw/gscdump/releases/tag/v7.12.1) published all twelve packages.
[Release run 42932874203](https://github.com/harlan-zw/gscdump/actions/runs/42932874203) passed for commit `abba58d15aec771056adcff8e1e9b6ab8cfa236f`.
The patch repairs append verification beside historical deleted entries in an Iceberg manifest.

The owner merged [release PR #284](https://github.com/harlan-zw/gscdump/pull/284) after both existing Google test logins failed refresh.
That storage patch has package, browser, Workers, and publication evidence. It has no successful live Google refresh evidence.
Keep the live Google verification gate above for future releases.

The hosted service adopted the package in [PR #1148](https://github.com/harlan-zw/gscdump.com/pull/1148).
[Production run 42960783347](https://github.com/harlan-zw/gscdump.com/actions/runs/42960783347) later deployed release `6ea6c9dde96db7e9f9b9579454883206660965a6`, including that adoption.
Seven owned stored API/MCP reads preserved their fixed-window totals and dates on that release.
These checks cover storage adoption. Use consumer rollout and route telemetry evidence for the broader v1 cutover gate.
