# ADR-0007 — Narrow `gte/gt/lt/lte/between` to date dimension; kill three server-side-guard findings

## Status

Accepted

## Context

A 2026-05-18 follow-up audit (third pass), scoped to items not closed by
[ADR-0005](./0005-gsc-api-coverage-deliberate-gaps.md) or
[ADR-0006](./0006-gsc-api-aggregation-and-inarray-validation.md),
surfaced four candidate findings. One was fixed; three are deliberately
not actioned.

## Fixed

### 1. Range operators on non-date dimensions are now a type error

The signatures `gte/gt/lt/lte/between` previously accepted
`Column<D extends Dimension>` for any dimension. GSC's wire operators
for non-date dimensions are only
`equals/notEquals/contains/notContains/includingRegex/excludingRegex`
(`searchanalytics/query.md` line 177), so `between(country, 'a', 'b')`
type-checked, fell through `extractSpecialFilters`'s date branch into
`otherFilters`, and was shipped to GSC as an invalid `operator: "between"`
filter (with `expression2` silently dropped). Google returned a 400.

Fix: narrowed the dimension overloads to `Column<'date'>`. Metric
overloads remain unchanged (`MetricColumn<M>` for numeric ranges, still
honored by `metricGte`/`metricBetween` etc.). Workspace consumers all
use these operators on `date` columns; no callers needed updating.

See `packages/gscdump/src/query/operators.ts` (the five overload
blocks). No new tests — the change is type-level and TS already covers
the metric-column path.

## Killed (decisions, not TODOs)

### 2. `inspect()` does not validate `inspectionUrl` is under the property's `siteUrl`

The GSC URL Inspection API requires `inspectionUrl` to live under the
target `siteUrl` (otherwise returns a 400 "Inspection URL must be under
the property"). `client.inspect` (`packages/gscdump/src/core/client.ts`)
sends both verbatim with no SDK-side guard, even though
`assertValidSiteUrl` already runs for `sites.add`.

Not actioned because: the server already returns a clear, specific
error; a client-side guard would have to model `sc-domain:` properties
versus full-URL properties versus property prefixes and would duplicate
server logic that has more authoritative information (e.g. which
sub-properties the user owns).

What would change this: a consumer report that the server error is
ambiguous in practice, or repeated user confusion about the
domain/prefix matching rules.

### 3. `sitemaps.submit/delete/get` do not validate `feedpath` is an absolute URL

The Sitemaps API requires a fully-qualified `feedpath` URL. The SDK
accepts any string and `encodeURIComponent`s it. A relative path
silently 400s.

Not actioned because: same shape as #2 — server enforces, returns a
clear error, and the cost of adding a URL validator (plus deciding what
counts as "absolute" relative to a `sc-domain:` property) is not paid
back by any concrete user-reported confusion.

What would change this: a consumer report that the server's response
on this case is unclear, or a partner integration that needs structured
client-side errors before hitting the wire.

### 4. `GscResponseAggregationType` includes `byNewsShowcasePanel`

`searchanalytics/query.md` line 212 enumerates the `responseAggregationType`
acceptable values as only `auto | byPage | byProperty`. Our type
(`contracts.ts:57`) also includes `byNewsShowcasePanel`.

Not actioned because: the same page (line 179) says "If you specify any
value other than auto, the aggregation type in the result will match
the requested type", which directly contradicts the enumerated response
values. Until Google clarifies, the wider type is the safer choice —
narrowing would force `as never` casts on exhaustiveness checks if
Google does echo `byNewsShowcasePanel` in the response. Cosmetic
widening, no runtime impact.

What would change this: an empirical observation that the API never
echoes `byNewsShowcasePanel`, or a Google docs update reconciling the
two passages.

## Consequences

Future audits comparing implementation to docs should consult ADRs
0005, 0006, and this ADR before re-filing any of items 2–4. The fixed
item is now type-enforced and will surface as a compile error if a
caller tries to misuse the operators.
