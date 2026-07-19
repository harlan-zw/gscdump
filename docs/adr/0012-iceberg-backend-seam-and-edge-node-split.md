# Iceberg backend is one `./iceberg` subpath; node-only writers stay on `./sink-node`

Amended 2026-07-19: `LocalIcebergSink` and `local-sink.ts` were deleted under
ADR-0021 after proving their integration tests were permanently self-skipping.
`./sink-node` now contains only the PyIceberg overwrite/delete recovery surface.
The edge/node split below remains the load-bearing decision.

The Iceberg storage backend was five flat files in `@gscdump/engine` (`iceberg-schema`, `iceberg-catalog`, `iceberg-overwrite-writer`, `sinks/iceberg-append-sink`, `sinks/local-iceberg-sink`) with ~25 symbols re-exported piecemeal through the root barrel, a `IcebergCatalogConfig` interface declared twice with two different shapes, and the only cross-package consumer (`@gscdump/cloudflare`) reaching the `IcebergTableName` union through the kitchen-sink root entry. In 2026-05 it was consolidated into `src/iceberg/` and exposed as a single `@gscdump/engine/iceberg` subpath.

The load-bearing constraint is the edge/node split, and it does not follow file boundaries. `./iceberg` is the **edge-safe** surface only — `schema` (pure), `catalog` (`icebird` is Workers-first: Web Crypto SigV4, `fetch` I/O, no node builtins), and the `IcebergAppendSink`. The Node-only writers stay OUT of `./iceberg`: `createLocalIcebergSink` (static `node:child_process`/`node:path`/`node:url`) and the PyIceberg-backed overwrite writer (`node:process`) are reachable only via `@gscdump/engine/sink-node`. So `local-sink.ts` and `overwrite-writer.ts` physically live in `src/iceberg/` for locality but are deliberately absent from `src/iceberg/index.ts`. Don't "tidy" them onto `./iceberg` — it would pull `node:*` into every edge/workerd consumer and break the package's `sideEffects: false` edge-safety claim.

Iceberg was removed from the root barrel entirely: import iceberg types/functions from `@gscdump/engine/iceberg`, not `@gscdump/engine`. The duplicate `IcebergCatalogConfig` in the overwrite writer (which omits `catalogToken` because its PyIceberg backends authenticate differently) was renamed `OverwriteWriterCatalogConfig`; the catalog client keeps `IcebergCatalogConfig`.

SemVer note for the next release: `@gscdump/engine` added the `./iceberg` subpath and removed iceberg symbols (plus the internal `gcOrphansImpl`/compaction helpers and the unused `./schedule` subpath) from the root entry.
