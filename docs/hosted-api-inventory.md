# Hosted API inventory

This is the migration evidence for the public v1 design. It inventories the
actual gscdump.com host, then overlays legacy package route builders/descriptors
and the generated public-v1 operations. Inventory inclusion comes from the
producer filesystem, not from either descriptor set.

The machine-readable snapshot is
[`hosted-api-inventory.json`](./hosted-api-inventory.json). Regenerate it from
the adjacent package and host checkouts with:

```bash
node scripts/validate-hosted-route-inventory.mjs --check
node scripts/validate-hosted-route-inventory.mjs --print
node scripts/validate-hosted-route-inventory.mjs --write

# If gscdump.com is elsewhere:
node scripts/validate-hosted-route-inventory.mjs --check \
  --host-root /path/to/gscdump.com
```

`--check` is the default. It rebuilds the inventory in memory and requires a
byte-for-byte match with the checked-in JSON. `--print` emits the deterministic
replacement for deliberate review; `--write` updates the checked-in snapshot.

## Snapshot summary

| Evidence | Count |
| --- | ---: |
| Live `server/api` route files | 220 |
| HTTP method/path operations | 220 |
| Legacy WebSocket operations | 2 |
| Total hosted operations | 222 |
| Legacy package endpoint descriptors | 63 |
| Generated public-v1 operation descriptors | 18 |
| Distinct hosted operations owned by a descriptor | 81 |
| Hosted operations without a descriptor | 141 |
| Schema-less legacy descriptors | 3 |
| Legacy descriptors with no producer handler | 0 |
| Legacy descriptor method/path collisions | 0 |

The inventory also includes `server/routes/ws/user.ts` and
`server/routes/ws/partner.ts` as the two legacy WebSocket operations.

The 141 unowned operations are not all public-contract gaps. The v1 review
classification is:

| Review outcome | Operations | Meaning |
| --- | ---: | --- |
| Accepted v1 slice | 18 | Executable descriptor, generated contract, SDK, and hosted route exist |
| Analytics candidate | 25 | Review for `/api/analytics/v1` |
| Partner candidate | 49 | Review for `/api/partner/v1` |
| Decision required | 51 | Shared user/site/team routes that need an explicit boundary decision |
| Outside public protocol | 77 | Admin, CLI, public-host, session, webhook, and other host concerns |
| Replace realtime | 2 | Replace both legacy sockets with `/ws/v1` |

An operation marked as a candidate is still not accepted into v1 until it has
an executable descriptor, schemas, auth/scopes, ownership checks, consistency,
SDK coverage, and producer contract tests. An operation outside protocol
should remain host-owned rather than receive a package descriptor merely to
make the count reach zero.

The accepted slice is intentionally limited to:

- `GET /api/partner/v1/users/{userId}/lifecycle`;
- `GET /api/partner/v1/users/{userId}/available-sites`;
- `POST /api/partner/v1/users/{userId}/sites`;
- `POST /api/partner/v1/users`;
- `PATCH /api/partner/v1/users/{userId}/tokens`;
- `GET /api/partner/v1/sites/{siteId}/indexing`;
- `GET /api/partner/v1/sites/{siteId}/indexing/urls`;
- `GET /api/partner/v1/sites/{siteId}/indexing/diagnostics`;
- `GET /api/partner/v1/sites/{siteId}/sitemaps`;
- `GET /api/partner/v1/sites/{siteId}/sitemaps/changes`;
- `GET /api/partner/v1/sites/{siteId}/analysis`;
- `GET /api/partner/v1/sites/{siteId}/analysis/bundle`;
- `DELETE /api/partner/v1/sites/{siteId}`;
- `POST /api/analytics/v1/sites/{siteId}/rows`;
- `POST /api/analytics/v1/sites/{siteId}/reports`;
- `POST /api/analytics/v1/sites/{siteId}/reports/detail`;
- `GET /api/realtime/v1/stream/head`;
- `POST /api/realtime/v1/tickets`.

The 63 legacy descriptors and their findings remain migration evidence. Their
three `noSchema` entries are not defects in the public HTTP-v1 descriptors;
they identify the remaining deployed-wire operations that cannot yet be treated
as fully typed package APIs.

## Concrete contract findings

Three current legacy descriptors use `noSchema`:

- `analytics.analyze`
- `partner.deleteSite`
- `partner.getSyncStatus`

V1 permits no schema-less descriptor. Each accepted operation needs request
and response schemas; removed operations should be deleted from the v1
registry rather than carried as placeholders.

All legacy descriptors now match a deployed producer method/path and no two
logical descriptors claim the same method/path. The producer's multiplexed
`POST /api/sites/{siteId}/sitemaps` route is represented by one typed
`partner.postSitemaps` descriptor with a closed action union; SDK convenience
methods delegate to that single wire operation. Sitemap membership lookup is
represented separately by the typed `partner.getSitemapMembership` descriptor.

## Scope and exclusions

The scanner includes every method-suffixed TypeScript file below
`server/api`, the explicitly reviewed generic R2 route, and both files below
`server/routes/ws`. Nitro `index` segments are removed and dynamic segments
are normalized (`[siteId]` → `{siteId}`, `[...path]` → `{path+}`). Descriptor
matching ignores placeholder names but preserves catch-all semantics.

One underscore-prefixed utility beneath `server/api` is excluded because it is
imported helper code, not a Nitro handler:

- `server/api/__gsc/sites/[siteId]/inspections/_d1-to-inspection-record.ts`

Three non-API `server/routes` files are recorded as out of inventory:

- `server/routes/__test/durable-job.get.ts`
- `server/routes/auth/google.get.ts`
- `server/routes/mcp.post.ts`

The validator fails when a new generic `.ts` file appears under `server/api`
without an explicit method rule. This prevents an implicit handler from
silently escaping the snapshot. The excluded files are also recorded in JSON,
so additions or removals produce a reviewed diff.

It also fails immediately when a route under one of the three public v1 HTTP
prefixes has no generated v1 descriptor, or when a generated v1 descriptor has
no hosted route. Updating the legacy snapshot cannot waive that two-way gate.

## How ownership is derived

The validator parses `packages/contracts/src/routes.ts` and
`packages/contracts/src/endpoints.ts` with the TypeScript AST for legacy
evidence. It also reads the three deterministic public-v1 OpenAPI artifacts.
It resolves legacy route-builder templates, normalizes legacy partner paths to
their hosted `/api` form, and matches both descriptor sets to producer handlers
by method plus normalized path.

Every operation row records:

- producer file, method, and path;
- current surface and proposed v1 review bucket;
- matching endpoint descriptor IDs (`descriptorOwners`);
- matching package route-builder IDs (`routeBuilderOwners`).

Every descriptor row records its owner, method/path, route builder, schema
status, and matching producer files. The findings section keeps schema gaps,
missing handlers, collisions, and all unowned hosted operations directly
queryable.

This snapshot is intentionally about the whole current producer. Only rows
marked `accepted-v1` are in the initial public slice; legacy candidates remain
unpublished. The protocol rules live in
[`hosted-api-v1.md`](./hosted-api-v1.md); changing the snapshot does not by
itself approve or version a public API operation.
