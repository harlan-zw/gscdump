# ADR-0022: gscdump.com owns canonical sitemap membership

Date: 2026-07-29
Status: Accepted

## Context

Sitemap behavior had three competing homes:

- nuxtseo.com fetched, parsed, traversed, and stored sitemap membership.
- `gscdump` and its CLI exposed another parser plus local entity snapshots.
- `@nuxtjs/sitemap` supplied parser internals even though it is an authoring module.

The copies disagreed on URL identity, traversal authorization, failure handling, limits, and what constituted a complete observation. GSC's Sitemaps API adds another data source, but it reports submitted document metadata rather than the documents' URL membership.

## Decision

### Package boundary

`sitemapd` v0.1 is the sole document reader. Applications import `sitemapd`, `sitemapd/parse`, or `sitemapd/fetch` directly. It owns XML and robots parsing, compressed and decoded byte limits, nested index traversal, redirects, cancellation, and tagged load errors. Every root, redirect, and child target passes through caller-supplied authorization.

`sitemapd` does not store observations. The old `gscdump/sitemap` wrapper and its framework parser dependency are deleted.

Product-level feed scoping stays in `gscdump/sitemap-identity`. That parser-free
subpath owns same-site canonical identity, duplicate evidence selection, and a
versioned exact membership digest. It does not use the analytics-only
`urlMatchKey`.

### Authority boundary

gscdump.com is the only canonical store for site sitemap membership. NuxtSEO and other consumers use the hosted contract and SDK. The CLI keeps:

- GSC list, get, submit, and delete operations
- explicit live discovery and URL traversal through `sitemapd`
- hosted current, history, membership, lastmod, and bulk-export reads

The CLI no longer stores a local sitemap snapshot.

### Identity and changes

A feed identity is its WHATWG-canonical absolute HTTP(S) URL with the fragment removed. Scheme and host casing plus default ports normalize; path casing, query, and trailing slash remain identity-bearing. Cross-origin child documents are permitted only when the caller's authorization policy accepts them. Membership `loc` values and their digests remain exact strings. `urlMatchKey` remains analytics-only.

Membership hashes are versioned and cover sorted exact `loc` values. Payload hashes additionally cover `lastmod`. A retained URL with a different `lastmod` emits an `updated` event containing both `previousLastmod` and `lastmod`. A retained unchanged URL advances its effective `lastSeenAt` from the complete feed generation without requiring a delta row.

### Atomic publication

One complete site traversal is one generation:

1. Each feed writes a cleanup descriptor first, then its immutable full base and immutable event file.
2. Finalization verifies every expected feed descriptor.
3. Dropped feeds receive explicit removal event references.
4. An immutable generation manifest is written with all base and event references plus previous-manifest ancestry.
5. The mutable site manifest is written last.

The mutable manifest is the only publication point. Readers use only references reachable from the current manifest. They never discover generations, bases, or events by listing a prefix. Therefore a crash before step 5 leaves the prior generation live and any new objects invisible.

Mutation implementations serialize writes per site. Finalization also re-reads the current publication immediately before the live switch, fencing a delayed writer if an implementation violates or loses that serialization boundary.

Cursor enumeration binds the generation id and exact feed selection to its feed index and row offset. It retains at most one decoded immutable feed base at a time. Hosted exact membership queries use generation-pinned DuckDB predicate pushdown over only the published bases, then recheck exact `loc` identity.

Bulk export prepares a generation-pinned async iterator. It orders feeds by exact identity and URLs by exact `loc`, decodes one immutable feed base at a time, and reads each selected base once for the lifetime of the iterator.

### Storage roles

- The R2-backed entity `DataSource` stores the mutable site manifest and immutable generation bases, events, and ancestry.
- Iceberg remains the analytics and export metadata plane. It may derive from a published generation but is not the live membership authority.
- D1 stores operational control state such as jobs, authorization, and sync bookkeeping. It does not own sitemap URL membership.

### Hosted contract

The v1 hosted surface returns generation metadata with every canonical read:

- current generation and feed list
- generation-pinned change history, including lastmod updates
- exact present, absent, or unknown membership evidence
- bounded cursor pages of URL and lastmod records
- a generation-pinned bulk export descriptor

Absence is evidence only for a complete published generation. Missing, incomplete, pruned, or pre-migration history returns `unknown`. Legacy GSC sitemap rows can be recorded only as `metadata_only` import evidence; they never prove URL membership. `membershipHistoryAvailableFrom` exposes the exact history floor.

This is a breaking package and contract change. The gscdump workspace moves to 2.0.0. `sitemapd` starts at 0.1.0.

## Consequences

- All consumers see one generation and one evidence model.
- Parser and traversal security fixes ship once in `sitemapd`.
- Complete-generation absence becomes safe to use.
- Storage cost favors immutable complete feed bases. Compaction and retention can change physical objects later, but must preserve manifest-pinned semantics and the declared history floor.
- Publishing `sitemapd@0.1` must precede installing or publishing gscdump 2.0.0.
