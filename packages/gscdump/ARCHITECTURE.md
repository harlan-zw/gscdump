# Architecture — `gscdump` (core)

`gscdump` is the edge-safe base package: GSC REST client, typed query builder,
and core primitives. No `node:*`, no DuckDB, no storage dependencies — it runs
on Node, browser, and workerd.

## Subpath exports

- `.` — REST client, auth, sites/sitemaps/indexing/inspection APIs, date
  helpers, scopes, errors, plus the small URL/normalize/sitemap helpers.
- `./query` — `gsc()` typed query builder, filter operators, `BuilderState`.
- `./query/plan` — logical plan compilation (`buildLogicalPlan`, dataset
  inference) consumed by `@gscdump/engine`.
- `./contracts` — driver/wire contract types.
- `./tenant` — site-id encode/decode + tenant URL normalization.

The export surface tracks the two consumers (`gscdump.com`, `nuxtseo.com`); see
`docs/adr/0012-export-surface-tracks-consumers.md`.

## Edge-safety

Everything here must stay importable in workerd. Node-only behavior belongs in
`@gscdump/engine` adapters (`@gscdump/engine/node`, `./filesystem`), never here.
