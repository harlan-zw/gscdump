# `BuilderState` is defined twice, by design

`BuilderState` (the wire shape of an analytics query) exists as two distinct
types in two packages:

- **`gscdump/query` — the canonical, strict type.** Produced by
  `gsc(...).getState()`, it carries the branded `Filter` union
  (`InternalFilter`, `JsonFilter`, the `__filterBrand` builder form). This is
  the type the query builder, `@gscdump/engine`, and `@gscdump/analysis` all
  use.
- **`@gscdump/contracts` — a lean structural mirror.** Same field names, but
  `Filter` is widened to `unknown`. Used by `@gscdump/sdk`
  (`packages/sdk/src/client.ts`) and the partner client/webhook types in
  `@gscdump/contracts` itself.

The deletion test suggests merging them: one `BuilderState` would remove an
apparent duplicate.

We keep both. Reason:

1. **`@gscdump/sdk` is deliberately lean.** Its only dependencies are
   `@gscdump/contracts`, `ofetch`, and `zod`. It is the thin HTTP client for
   the gscdump.com partner API and must not pull in the whole `gscdump` query
   builder just to type a `state` argument. Merging would force `@gscdump/sdk`
   to depend on `gscdump`.
2. **Layering forbids the reverse.** `@gscdump/contracts` is the
   dependency-free leaf; `gscdump` depends on it. The canonical strict type
   cannot move down into `@gscdump/contracts` without a cycle.
3. **The structural type is sufficient at the wire boundary.** The SDK only
   forwards `state` as an opaque payload to the server; it never inspects the
   branded `Filter`. `Filter = unknown` is the correct contract there. The
   accompanying `builderStateSchema` is intentionally `z.record(z.unknown())` —
   the wire payload is validated server-side, not in the SDK.

Don't propose merging the two `BuilderState` types in future architecture
passes. If `@gscdump/sdk` ever takes a dependency on `gscdump` for other
reasons, revisit: at that point the strict `gscdump/query` type could become
the single definition and `@gscdump/contracts` would re-export it.
