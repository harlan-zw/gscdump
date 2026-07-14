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

# If gscdump.com is elsewhere:
node scripts/validate-hosted-route-inventory.mjs --check \
  --host-root /path/to/gscdump.com
```

`--check` is the default. It rebuilds the inventory in memory and requires a
byte-for-byte match with the checked-in JSON. `--print` emits the deterministic
replacement for deliberate review; it does not edit files.

## Snapshot summary

| Evidence | Count |
| --- | ---: |
| Live `server/api` route files | 211 |
| HTTP method/path operations | 212 |
| Legacy WebSocket operations | 2 |
| Total hosted operations | 214 |
| Legacy package endpoint descriptors | 64 |
| Generated public-v1 operation descriptors | 4 |
| Distinct hosted operations owned by a descriptor | 65 |
| Hosted operations without a descriptor | 149 |
| Schema-less legacy descriptors | 10 |
| Legacy descriptors with no producer handler | 2 |
| Legacy descriptor method/path collisions | 1 |

The 212 HTTP operations exceed the 211 live files because
`server/api/r2-data/[...path].ts` deliberately handles both `GET` and `HEAD`.
The inventory also includes `server/routes/ws/user.ts` and
`server/routes/ws/partner.ts` as the two legacy WebSocket operations.

The 149 unowned operations are not all public-contract gaps. The v1 review
classification is:

| Review outcome | Operations | Meaning |
| --- | ---: | --- |
| Accepted v1 slice | 4 | Executable descriptor, generated contract, SDK, and hosted route exist |
| Analytics candidate | 25 | Review for `/api/analytics/v1` |
| Partner candidate | 55 | Review for `/api/partner/v1` |
| Decision required | 46 | Shared user/site/team routes that need an explicit boundary decision |
| Outside public protocol | 82 | Admin, CLI, public-host, session, webhook, and other host concerns |
| Replace realtime | 2 | Replace both legacy sockets with `/ws/v1` |

An operation marked as a candidate is still not accepted into v1 until it has
an executable descriptor, schemas, auth/scopes, ownership checks, consistency,
SDK coverage, and producer contract tests. An operation outside protocol
should remain host-owned rather than receive a package descriptor merely to
make the count reach zero.

The accepted slice is intentionally only:

- `GET /api/partner/v1/users/{userId}/lifecycle`;
- `POST /api/analytics/v1/sites/{siteId}/rows`;
- `GET /api/realtime/v1/stream/head`;
- `POST /api/realtime/v1/tickets`.

The 64 legacy descriptors and their findings remain migration evidence. Their
ten `noSchema` entries, two missing handlers, and one collision are not defects
in these four v1 descriptors; they prevent those legacy operations from being
promoted until each is resolved deliberately.

## Concrete contract findings

Ten current legacy descriptors use `noSchema`:

- `analytics.analyze`
- `partner.deleteSite`
- `partner.deleteTeam`
- `partner.getContentVelocity`
- `partner.getSyncStatus`
- `partner.refreshSitemaps`
- `partner.removeTeamMember`
- `partner.renameTeam`
- `partner.submitSitemap`
- `partner.updateTeamMemberRole`

V1 permits no schema-less descriptor. Each accepted operation needs request
and response schemas; removed operations should be deleted from the v1
registry rather than carried as placeholders.

Two descriptors have no matching hosted method/path handler:

- `analytics.queryRows` → `POST /api/__gsc/sites/{siteId}/rows`
- `partner.getAnalysis` → `GET /api/sites/{siteId}/analysis`

One method/path is claimed by two logical descriptors:

- `POST /api/sites/{siteId}/sitemaps` → `partner.submitSitemap` and
  `partner.refreshSitemaps`

The producer currently multiplexes sitemap actions through one route. V1 must
either model one typed operation with a closed action contract or split it
into distinct paths. It cannot publish two indistinguishable descriptors.

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
