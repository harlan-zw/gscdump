# ADR-0008 — Reject `date`/`searchType` leaves inside `or()` groups

## Status

Accepted

## Context

A 2026-05-18 audit (fourth pass), scoped to items not closed by ADRs
0005–0007, surfaced one finding. It was a genuine silent-corruption
bug, fixed in the same change as this ADR. No items were killed this
iteration.

## Fixed

### 1. `or(between(date, …), other)` silently became AND

`date` and `searchType` map to **top-level** request fields
(`startDate`/`endDate`/`type`) on the GSC `searchanalytics.query`
endpoint — they are not real `dimensionFilterGroups[]` entries. The
SDK's `extractSpecialFilters` pulls them out of any filter (including
`or()` groups) and promotes them to those top-level fields, which the
API always AND-applies against everything else.

Result: if a caller wrote

```ts
or(between(date, '2024-01-01', '2024-01-31'), eq(query, 'foo'))
```

intending `(date in range) OR (query='foo')`, the SDK silently sent
`(date in range) AND (query='foo')` instead. No warning, no error,
wrong data.

Fix: `or()` (`packages/gscdump/src/query/operators.ts`) now throws on
any leaf whose dimension is `date` or `searchType`, with a message
explaining they are top-level fields and pointing the caller at the
right construction (apply the date range outside the `or()` group;
use `.type()` instead of an embedded `searchType` filter).

Side effect: the nested-date fallback in `extractSpecialFilters`
(lines 195-208 — adopt nested `startDate`/`endDate`/`searchType` when
the outer scope didn't set them) becomes unreachable through public
API surface, since OR groups can no longer carry those leaves. The
fallback stays as defensive code; the test that exercised it was
replaced with a `toThrow` assertion.

## Killed findings

None this iteration.

## Consequences

Future audits should consult ADRs 0005–0008 before re-filing
`or()`-semantics findings. The new `or()` guard prevents the silent
collapse at build time (the caller sees the throw the first time they
run the query) instead of producing wrong rows.

See `packages/gscdump/src/query/operators.ts` for the guard and
`packages/gscdump/test/query/operators.test.ts` +
`packages/gscdump/test/query/nested-date.test.ts` for coverage.
