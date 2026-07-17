# Consumer row queries use `BuilderState`, resolved by the host table layer

Consumer-mode row queries should keep `BuilderState` as the wire contract.

The alternative was to introduce a smaller, consumer-only query shape for
`useGscRowQuery`. We reject that. `BuilderState` is already the canonical
query-builder payload, is exported through `@gscdump/sdk/query`, and maps to
the same planner/resolver concepts used by DuckDB-backed and future
Iceberg-backed table paths.

Direction:

1. `@gscdump/nuxt` composables should continue to accept or produce
   `BuilderState` for row-shaped analytics queries.
2. Consumer/host mode should translate `BuilderState` against the host's
   DuckDB/Iceberg table layer.
3. Do not add a second simplified row-query wire shape unless there is a
   concrete consumer that cannot express its needs through `BuilderState`.

This keeps the browser, hosted, and future table-backed paths aligned around
one query representation instead of creating a parallel dialect that would
need its own validation, docs, and compatibility rules.
