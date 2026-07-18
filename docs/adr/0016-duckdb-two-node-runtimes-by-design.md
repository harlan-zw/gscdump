# ADR-0016 — Two DuckDB runtimes on Node are deliberate, not duplication

## Status

Accepted

## Context

A Node `gscdump` process can load **two** DuckDB runtimes:

1. **`@duckdb/duckdb-wasm` node-blocking build** (`duckdb-node-blocking.cjs`),
   wrapped by `engine/src/adapters/duckdb-node.ts` as the `DuckDBHandle` behind
   `@gscdump/engine/node`. This is what `createNodeHarness` wires into the
   storage engine, so **all** sync / query / compaction / `runRawSql` work in
   the CLI runs on it.
2. **`@duckdb/node-api`** (native, `DuckDBInstance`), used directly by only two
   CLI commands: `dump` (`packages/cli/src/commands/dump.ts`) and `export`
   (`packages/cli/src/commands/export.ts`).

At a glance this reads as accidental duplication — two DuckDB dependencies, two
ways to run `read_parquet`, even a DuckDB *version skew* (`duckdb-wasm ^1.32.0`
vs `node-api 1.5.1`). A consolidation audit considered collapsing to one runtime
and rejected it.

## Decision

**Keep both.** The split is a capability boundary, not redundancy.

### Why the engine handle stays WASM-node-blocking

- **One codec, every runtime.** The engine's codec/executor (`duckdb.ts`) is
  built on DuckDB-WASM's virtual-FS API — `registerFileBuffer` /
  `copyFileToBuffer` / `dropFiles`. The *same* code serves the browser
  (`AsyncDuckDB`), Workers, and Node because all three expose that vFS surface.
  `@duckdb/node-api` has no `registerFileBuffer`; porting the engine to it would
  mean a second, disk-temp-file codec maintained in parallel.
- **Browser parity is tested.** `duckdb-node-contract.test.ts` asserts the Node
  handle and the browser wasm path return identical rows for identical fixtures.
  That guarantee holds *because* both run the same DuckDB build. Swapping Node to
  native node-api (a different DuckDB version) would let SQL semantics, float
  formatting, and type coercion drift, and the contract test could no longer
  stand in for browser behaviour.
- **The OOM argument doesn't apply on Node.** DuckDB-WASM is bypassed in
  *Workers* because writes/compactions grow WASM linear memory monotonically and
  can't shrink (`workers-duckdb.ts`). On Node that pressure largely evaporates:
  under `NODE_RUNTIME` the blocking build bridges to the **real filesystem**, so
  `COPY TO '<path>'` writes to disk (not the vFS heap) and `read_parquet` reads
  inputs straight from disk via the DataSource `uri()` fast-path
  (`filesystem.ts` returns the absolute path; `duckdb.ts compactRows` /
  `execute` take the all-URIs branch and never `registerFileBuffer` local
  inputs). Only transient JS `Uint8Array`s cross between, and those are GC'd.

### Why `dump` / `export` stay native node-api

- **`export` emits a persistent `.duckdb` database file** via
  `DuckDBInstance.create(outPath)` for portable distribution (ATTACH from a
  desktop DuckDB, ship to a CDN, browser re-attach). The in-memory vFS WASM build
  has no natural equivalent for producing that on-disk database format.
- **`dump` / `export` are bulk one-shot conversions** over files already on
  local disk. Native node-api reads them with zero JS-side copy and at native
  speed — the right tool for a terminal command that may touch every partition.
- They are CLI-only, so the native binary never reaches the edge-safe `gscdump`
  core or the browser/Worker adapters.

## Consequences

- **Do not "consolidate" these into one runtime.** A future cleanup that merges
  them would either rewrite the engine codec onto disk-temp files (losing the
  browser-shared vFS codec and the parity test) or route `dump`/`export` through
  the vFS handle (losing native bulk speed and the persistent-`.duckdb` output).
- **Drift is the real risk, and it is fenced.** The one place the two runtimes
  must agree is parquet read semantics. Legacy-VARCHAR `date` canonicalization
  is now a single shared fragment — `dateReplaceClause` in
  `engine/src/sql-fragments.ts`, fed by `dateColumnsFor` in `schema.ts` — used by
  the engine codec (`'string'` form) and both CLI commands (`dump` → `'string'`,
  `export` → `'date'`). Add new cross-runtime read invariants as shared fragments
  there, never as hand-rolled SQL in a command.
- **A held handle survives `resetNodeDuckDB()`.** The handle's methods resolve
  the instance through a lazy `getSingleton(opts)` accessor, so a handle captured
  by `createNodeHarness` re-initializes transparently on its next call after a
  reset nulls the singleton, rather than dereferencing null. This keeps the door
  open for a long-running command to call `resetNodeDuckDB()` between sites to
  reclaim the instance without invalidating the harness it already holds.
