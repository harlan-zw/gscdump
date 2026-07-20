# ADR-0005 — Deliberate gaps in GSC API surface coverage

## Status

Accepted

## Context

A 2026-05-18 audit of `packages/gscdump/src/` against the GSC REST docs
(`docs/gsc-api-reference/webmaster-tools/v1/`) surfaced ten candidate
gaps/bugs. Two were fixed (Retry-After honoring on 429/503, exposing
`responseAggregationType` from `client.query`). The remaining eight are
deliberate non-actions: capturing them here so the same audit doesn't
re-raise them as bugs.

## Decision

The following audit findings are intentionally not implemented. Each is a
*decision*, not a TODO.

### 1. `rowLimit > 25000` is not clamped in `resolveToBody`

Google's wire cap is 25,000 rows per request. The builder `.limit(n)`
deliberately models a *total row cap* across paginated pages, not a
per-request cap. The pagination layer in `client.query` already chunks at
25k. Clamping in `resolveToBody` would silently break the documented
"`.limit(n)` returns at most n rows total" semantic for callers using
`.toBody()` to drive their own pagination. Raw-body users passing
`rowLimit > 25000` will get a clean 400 from Google.

### 2. `groupType: 'or'` is sent despite docs saying only `and` is supported

The docs (`searchanalytics/query.md`) flag `or` as "not yet supported", but
the API currently accepts it. The `or` group type is load-bearing for
`inArray` and partner-wire OR groups. We pass it through and let Google
decide. Comment at `resolver.ts:342-344` flags the risk; revisit only when
production 400s appear.

### 3. No multipart batch transport (`/batch/webmasters/v3`)

Google deprecated the global HTTP batch endpoint in 2019. Sequential
requests with concurrency control (`api/batch.ts:runSequentialBatch`) are
the supported path. Implementing multipart batch would add transport
complexity for an endpoint Google has signalled they will eventually
remove.

### 4. No Indexing API batch variant

Same reasoning as #3. Indexing API still nominally supports `/batch`, but
adding it would duplicate `runSequentialBatch` infrastructure for marginal
gain — Indexing quota (~200/day) is the binding constraint, not request
overhead.

### 5. URL inspection sub-results are JSON-stringified in `inspectUrlFlat`

`inspectUrlFlat` (`api/inspection.ts:85-123`) is a deliberate flat
projection for SQL-row storage. Structured sub-results (`mobileIssues`,
`richResultsItems`, `ampIssues`, `sitemaps`, `referringUrls`) are
stringified by design so the result maps to a single row. Callers needing
typed access use `client.inspect()` directly and consume
the package-owned `InspectUrlIndexResponse` structural wire contract.

### 6. Rate-limit headers other than `Retry-After` are not exposed

We honor `Retry-After` in the retry loop (the only header that affects
behavior). Surfacing `X-RateLimit-Remaining` or similar would require
threading response objects through every API surface; no consumer has
asked for it.

### 7. `Site.siteUrl` typed as required string

Google's wire-level `siteUrl` is `string | null | undefined`. Our normalized
`Site.siteUrl` narrows to `string`. The narrowing is sound at runtime
because every code path that produces an `ApiSite` populates `siteUrl`
(from `sites.list` response entries, which always carry the field).
Widening would force null-checks on every consumer for a case that doesn't
occur.

### 8. Filter expression length (4096-char cap) is not validated client-side

Filter expressions over 4096 chars 400 from Google with a clear message.
Adding client-side validation would duplicate server enforcement for a
case that's almost always a programming bug, not user input.

## Consequences

Future audits comparing implementation to docs should consult this ADR
before filing any of the eight items above. New gaps not enumerated here
are fair game.

The two findings *not* in this list (Retry-After honoring,
`responseAggregationType` exposure) were fixed in the same change that
introduced this ADR; see `core/client.ts:createFetch` and the
`QueryReturn` type.
