# Strict `BuilderState` and wire `BuilderStateWire` are separate concepts

The analytics query payload has two deliberately different type strengths and
v1 names them accordingly:

- **`gscdump/query` exports `BuilderState`.** This is the canonical strict
  query-builder type. It carries the branded filter union used by the builder,
  planner, engine, and analysis packages.
- **`@gscdump/contracts` exports `BuilderStateWire`.** This is the lean
  structural transport shape used by hosted contracts and `@gscdump/sdk`.
  Its filter is intentionally untrusted until the host normalizes it.

The old design exported both concepts as `BuilderState`, which looked like
duplicate ownership and made imports ambiguous. The v1 break renames the
contract shape instead of pretending the two validation boundaries are the
same.

`@gscdump/contracts` remains a dependency-free leaf and `@gscdump/sdk` remains
transport-only, so neither depends on the strict query builder. At a host
boundary, pass `BuilderStateWire` through `normalizeBuilderState` from
`gscdump/query` before planning or execution. Application code constructing
queries imports `BuilderState` from `gscdump/query`.

Do not add a `BuilderState` alias to contracts or re-export query types from
the SDK. Those aliases recreate the ambiguity removed for v1.
