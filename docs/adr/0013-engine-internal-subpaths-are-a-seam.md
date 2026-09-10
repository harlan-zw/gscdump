# ADR-0013 — Engine internal subpaths are a deliberate seam, not a leak

## Status

Accepted

## Context

The export-surface audit ([export surface decision](./0012-export-surface-tracks-consumers.md)) flagged a class of `@gscdump/engine`
subpaths that neither consumer site (`gscdump.com`, `nuxtseo.com`) imports
directly:

`./contracts`, `./snapshot`, `./planner`, `./schema`, `./sql`,
`./sql-fragments`, `./scope`, `./arrow`.

By the "demand = the two sites" rule, a naive reading says privatize them
behind a single `@gscdump/engine/internal` door. We considered that and
rejected it.

## Decision

**Keep these as individual subpaths.** They are a deliberate lightweight-import
seam for sibling packages, and they pass the deletion test:

1. **Each has ≥2 independent sibling consumers.** `@gscdump/analysis` imports
   `./planner`, `./sql`, `./sql-fragments`, and `./contracts` across ~27
   analyzer modules; `@gscdump/engine-duckdb-wasm` and `@gscdump/engine-sqlite`
   both import `./scope`; `@gscdump/engine-duckdb-wasm` imports `./arrow` and
   `./schema`; `@gscdump/cloudflare` imports `./contracts` and `./schema`.
2. **They serve the sites transitively.** `@gscdump/analysis` *is* imported by
   both sites (42× from gscdump.com). The engine subpaths analysis depends on
   are part of the dependency closure the sites actually run.
3. **Each is a distinct concept with a real import-cost reason.** They let a
   sibling pull pure planner/SQL/schema logic *without* dragging in the engine's
   heavy optional peers (`icebird`, `hyparquet`, `@duckdb/duckdb-wasm`) that the
   `.` barrel transitively references. Collapsing them into one `/internal`
   barrel would defeat that — a single entry would re-export everything and pull
   the heavy graph back in, and the barrel itself would be the shallow
   grab-bag module the architecture guidelines forbid.

Collapsing them would churn ~100 sibling import sites for **zero** change to the
published site-facing surface, while making the engine harder to treeshake.

## Consequences

- These subpaths stay in `@gscdump/engine`'s `exports` map and are treated as
  the engine's public API *for sibling packages*, distinct from the site-facing
  surface.
- Future export audits should not re-flag them as "unused by the sites." The
  test for an engine subpath is: does a sibling package import it AND is that
  sibling in the sites' dependency closure? If yes, it stays.
- Runtime adapters (`./node`, `./filesystem`, `./hyparquet`, `./r2`,
  `./r2-manifest`, `./iceberg`) and `./vendor/hysnappy` (aliased by
  `gscdump.com/nuxt.config.ts`) remain separate for the same
  runtime-portability and build-alias reasons.
