# Consumer row queries use `BuilderState`, resolved by the host table layer

Consumer-mode row queries should keep the strict `BuilderState` as their
construction contract and use `BuilderStateWire` only at HTTP boundaries.

The alternative was to introduce a smaller, consumer-only query shape for
`useGscRowQuery`. We reject that. `BuilderState` is already the canonical
query-builder payload, is exported through `gscdump/query`, and maps to the
same planner/resolver concepts used by DuckDB-backed and Iceberg-backed table
paths. `@gscdump/contracts` names its permissive transport mirror
`BuilderStateWire` (ADR-0009), so the boundary is explicit without inventing a
second query dialect.

Direction:

1. Consumer composables accept or produce strict `BuilderState` for
   row-shaped analytics queries.
2. Hosted transport accepts `BuilderStateWire`, normalizes it through
   `gscdump/query`, then resolves the strict result against the host's
   DuckDB/Iceberg table layer.
3. Do not add a second simplified row-query wire shape unless there is a
   concrete consumer that cannot express its needs through `BuilderState`.

This keeps the browser, hosted, and future table-backed paths aligned around
one query representation instead of creating a parallel dialect that would
need its own validation, docs, and compatibility rules.
