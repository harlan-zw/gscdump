# ADR-0006 — Client-side validation for `aggregationType` and `inArray([])`

## Status

Accepted

## Context

A 2026-05-18 follow-up audit of `packages/gscdump/src/` against the GSC
REST docs (`docs/gsc-api-reference/webmaster-tools/v1/`), scoped to items
not closed by [ADR-0005](./0005-gsc-api-coverage-deliberate-gaps.md),
surfaced three findings. All three were valid; all three were fixed in
the same change that introduced this ADR. There were no killed items
this iteration.

This ADR records the closure so the next audit doesn't re-derive the
same fixes from the docs.

## Decision

### 1. `aggregationType: 'byProperty'` is rejected when grouping or filtering by page

`searchanalytics/query.md` line 179 explicitly forbids `byProperty` when
the request groups or filters by page. Previously
`resolveToBody` (`query/resolver.ts`) only rejected `byProperty` for
`type=discover|googleNews`. The page-group/page-filter case reached
Google and returned a 400 the SDK could have caught.

Fix: in `resolveToBody`, after resolving filter groups, throw if
`aggregationType === 'byProperty'` and either `body.dimensions` includes
`page` or any leaf filter targets the `page` dimension.

### 2. `aggregationType: 'byNewsShowcasePanel'` enforces NEWS_SHOWCASE + no-page

Per `query.md` line 179, `byNewsShowcasePanel` requires:

- `type ∈ {discover, googleNews}` (already enforced).
- A `searchAppearance equals NEWS_SHOWCASE` dimension filter.
- No `page` grouping or `page` filter.
- No other `searchAppearance` filter.

Fix: after filter-group resolution, validate the three additional
constraints. Throws with a single clear message naming the missing
filter or the disallowed dimension.

### 3. `inArray(col, [])` throws instead of silently matching everything

`inArray` (`query/operators.ts`) produced a filter group with zero
leaves, which `resolveFilter` then dropped entirely — so
`inArray(query, dynamicList)` with an empty `dynamicList` silently
unbounded the query instead of matching nothing. The "silently drop the
constraint" failure mode is the practical bug.

Fix: `inArray` throws if `values.length === 0`. Callers that legitimately
have an empty list should short-circuit before building the query (no
results possible) rather than emit a degenerate filter. This matches
typical SQL `IN ()` semantics, where most engines also reject the empty
list.

## Killed findings

None this iteration. Every audit finding outside ADR-0005's closed set
turned out to be a real client-side gap.

## Consequences

Future audits comparing implementation to docs should consult ADR-0005
*and this ADR* before filing repeat findings for `aggregationType`
constraints or `inArray([])` behaviour. New gaps not enumerated in
either ADR remain fair game.

See `query/resolver.ts` (aggregationType block, after `filterGroups`
resolution) and `query/operators.ts` (`inArray` guard) for the
implementations. Tests are in `test/query/validation.test.ts` and
`test/query/operators.test.ts`.
