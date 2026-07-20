# v1 closeout

Last updated: 2026-07-20

Working line: **`0.40.x`**. This file lists only work that still gates v1 or
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

Run `pnpm test:e2e` with `GSC_ACCESS_TOKEN`, or with
`GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` + `GSC_REFRESH_TOKEN`, before the v1 tag.
Credential-free local runs intentionally skip live Google assertions.

## Completion bar

V1 is ready when package build/typecheck/tests pass, consumer migrations and
their focused tests pass, live Google e2e has run with credentials, and every
remaining compatibility surface above has an explicit owner and deletion
gate. The frozen manifest baseline is Node.js 22+, compatible (`^`) published
package-family runtime dependencies, DuckDB-WASM `1.33.1-dev57.0` in development
with a compatible peer range, and no vulnerable Hono `4.12.23` in the release
lockfile. No new 0.x compatibility aliases should be added.
