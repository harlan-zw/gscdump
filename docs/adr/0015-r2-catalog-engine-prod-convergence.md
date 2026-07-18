# 0015. The engine models per-team R2 catalogs; correctness logic converges into it

- Status: proposed
- Date: 2026-06-19
- Extends ADR-0014 (catalog read path lives in the engine) to the write path,
  the topology, and the revision model.

## Context

ADR-0014 pulled the catalog *read* path into `@gscdump/engine` to end
consumer/engine divergence. A 2026-06-19 audit (engine code + prod consumer
`gscdump.com` + official Cloudflare R2 Data Catalog docs) found the divergence
is wider than the read path, and that two engine docstrings assert facts the
official docs refute.

### The engine encodes a topology prod has retired

- **Global tables.** `iceberg/schema.ts` states "GLOBAL tables — NOT per-site
  tables." Prod abandoned this: since 2026-06-09 it runs **per-team R2 Data
  Catalogs** (~75/77 teams flipped) to escape the shared-catalog 429 commit
  storm and cross-tenant manifest scan. `partition-prune.ts`'s "O(all tenants)"
  premise is largely moot per-team.
- **Overwrite writer.** `iceberg/overwrite-writer.ts` (PyIceberg + Cloudflare
  Container) is dead. The live revision strategy is the consumer's
  `recent-overlay`: the non-stable GSC tail is written to a separate,
  non-Iceberg parquet, full-overwrite each sync, with read-time date-boundary
  dedup (`lake date <= boundary`, `overlay date > boundary`). `sink.ts`'s "there
  is no overwrite path" is the live truth; the overwrite writer contradicts it.
- **Idempotency.** Exactly-once is enforced by the D1 `iceberg_ingested_days`
  ledger plus the `daily/iceberg-reconcile` detect-and-repair job — both
  consumer-side, both slated for retirement. The engine append sink shipped no
  dedup of its own; reads are `SUM(metric) GROUP BY <dimension>`, so any
  duplicate identity tuple double-counts with no downstream correction (the
  2026-04 compaction-corruption class).

### Load-bearing correctness lives in the consumer, not the engine

- **R2 SQL partition-equality bug.** `WHERE site_id = '<uuid>'` returns 0 rows;
  `WHERE CONCAT(site_id,'') = '<uuid>'` returns the correct rows. 49/72 teams are
  multi-site, so the CONCAT workaround is load-bearing — and it lives only in the
  consumer. R2 SQL also has no window functions, so the resolver's `SUM() OVER()`
  / `ROW_NUMBER()` cannot run there; rich queries must stay on DuckDB over
  presigned parquet. Which read paths are R2 SQL vs DuckDB is implicit.

### Official docs refute two engine docstrings, and confirm a cost gap

- **Managed compaction is not free or automatic.** Docs: off by default,
  per-bucket enable, billed, capped at **2 GB/hour/table** (beta). `append-sink.ts`
  treats the small-file fan-out as "handled by R2 Data Catalog managed
  compaction." Investigation of the consumer confirms provisioning
  (`provisionTeamCatalog` → bucket-create → CORS → catalog-enable → table-create)
  **never enables compaction** on any per-team catalog, and there is no job or
  script that does. The fan-out is growing with compaction OFF.
- **Orphan files are never auto-cleaned.** Docs are explicit ("not previously
  referenced by snapshots are not cleaned up"). `catalog.ts` claims R2 reclaims
  the 429-retry re-upload orphans — false; they accrue storage cost forever.
- **Snapshot expiry** (default 30d/retain-5) must be explicitly enabled; the
  consumer has deliberately deferred it.
- **Undocumented and load-bearing:** per-account table/catalog count limit, the
  per-table commit ceiling (the 429), field-id assignment on `createTable`,
  partition transforms beyond `day()` (we use `month()`), and delete-file /
  merge-on-read support on read. None are answerable from docs.

## Decision

The engine is the source of truth for the R2 Data Catalog model; prod-correctness
logic converges into it, and the dead model is removed.

1. **Intra-commit dedup in the append sink (LANDED).** `createIcebergAppendSink`
   now collapses buffered records sharing an Iceberg identity tuple
   (`site_id` + `search_type` + natural key) last-wins at the commit boundary
   (`dedupeByIdentity`). This is the only dedup point in the append model and
   closes the intra-run double-count class. Cross-RUN exactly-once still requires
   the ledger (or a read-before-append); retiring the ledger is gated on building
   that, NOT on this guard.

2. **Model per-team catalogs as the supported topology.** Replace the
   "global tables" language in `iceberg/schema.ts`; make the per-team catalog the
   first-class shape and treat the single global catalog as legacy. Re-evaluate
   whether `partition-prune.ts` still earns its complexity per-team.

3. **Delete `iceberg/overwrite-writer.ts` and the PyIceberg overwrite path.**
   Pull the `recent-overlay` write+read contract into the engine as the canonical
   revision mechanism so the seam is owned in one place (the ADR-0014 argument,
   applied to the write side).

4. **Own the read-path correctness quirks in the engine.** Encode the R2 SQL
   partition-equality workaround and make the R2-SQL-vs-DuckDB capability split
   explicit (R2 SQL: no window functions, partition-key ordering only), so a
   consumer cannot route a window-function query to R2 SQL or emit a bare
   `site_id =` predicate.

5. **Correct the false docstrings and close the maintenance gap.** Fix
   `append-sink.ts` / `catalog.ts`; add compaction-enable + snapshot-expiry to
   per-team provisioning; retarget orphan cleanup (the legacy `gc.ts` capability)
   at the Iceberg `data/` path. (Compaction-enable LANDED consumer-side:
   `provisionTeamCatalog` now POSTs `r2-catalog/{bucket}/maintenance-configs`
   with `compaction: enabled, target_size_mb: 128` on both the provision and the
   `ready` re-provision paths — the latter is the idempotent backfill lever for
   the existing fleet. Snapshot-expiry stays deferred per NEXT_STEPS.md; orphan
   sweep still pending.)

6. **Record the empirical-probe results.** Run probes against the live catalog
   with icebird for each undocumented assumption above and write the answers into
   the `iceberg/schema.ts` contract, replacing the current advisory/"unverified"
   comments.

## Consequences

- The append path gains defense-in-depth independent of D1, unblocking the
  ledger's retirement once a cross-run guard (read-before-append) exists.
- Removing the overwrite writer and folding in `recent-overlay` collapses two
  revision models into one, owned by the engine.
- Per-team provisioning grows two maintenance steps (compaction, expiry) and the
  engine grows an orphan sweep; without them, storage and small-file cost grow
  unbounded per catalog.
- The undocumented assumptions become verified contract instead of comments, so
  a future Cloudflare change surfaces as a contract diff, not a silent regression.
- Items 2-6 are sequenced follow-ups; only item 1 has landed.
