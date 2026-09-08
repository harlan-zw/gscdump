# Hosted API inventory

This inventory matches package descriptors to routes in the gscdump.com host checkout.
It records implemented routes, including legacy mismatches.
It does not verify production deployment or consumer migrations.

The snapshot uses host commit
[`b93a2e6`](https://github.com/harlan-zw/gscdump.com/commit/b93a2e6f224dd3eda1d33f708fde726442c49a83).
The machine-readable data is [`hosted-api-inventory.json`](./hosted-api-inventory.json).

## Regenerate

Run from this repository with the gscdump.com checkout available:

```bash
node scripts/validate-hosted-route-inventory.mjs --check --host-root /path/to/gscdump.com
node scripts/validate-hosted-route-inventory.mjs --print --host-root /path/to/gscdump.com
node scripts/validate-hosted-route-inventory.mjs --write --host-root /path/to/gscdump.com
```

`--check` compares the rebuilt inventory with the saved JSON.
`--print` previews the replacement; `--write` saves it.
Review the diff before committing a regenerated snapshot.

## Snapshot summary

| Evidence | Count |
| --- | ---: |
| HTTP route files and operations | 114 |
| Legacy public WebSocket operations | 0 |
| Legacy package descriptors | 36 |
| Public v1 HTTP descriptors | 55 |
| Hosted operations matched to a descriptor | 57 |
| Hosted operations without a descriptor | 57 |
| Legacy descriptors without schemas | 3 |
| Legacy descriptors without a host handler | 34 |
| Descriptor method/path collisions | 0 |

All 55 public v1 HTTP descriptors match host routes.
The remaining 34 unmatched descriptors belong to legacy exports.
A legacy SDK method's existence does not guarantee a working host route.
Use v1 for new integrations.

| Classification | Operations | Meaning |
| --- | ---: | --- |
| Accepted v1 | 55 | Public descriptor and matching host route |
| Partner candidate | 3 | Needs review before promotion to v1 |
| Decision required | 7 | User, Site, or Team route with an unresolved public boundary |
| Outside public protocol | 49 | Host-owned routes, including admin, session, CLI, and webhook routes |

These classifications cover all host operations.
They are separate from descriptor ownership.
An unmatched host route does not automatically need a public descriptor.

## Remaining legacy gaps

Three legacy descriptors lack schemas:

- `analytics.analyze`
- `partner.deleteSite`
- `partner.getSyncStatus`

The JSON `findings.descriptorIdsWithoutHandler` list names the 34 descriptors whose host handlers are absent.
Check that list before using legacy route builders or SDK clients.
These gaps do not change the public v1 contracts.

Sitemap v1 operations provide snapshots, changes, exact membership, URL pages, bulk exports, and actions.
Google's submitted-sitemap metadata does not prove URL membership.

## Scanner scope

The scanner reads method-suffixed TypeScript files under the host's `server/api` directory.
It also checks explicitly supported generic routes and legacy public socket paths.
It removes Nitro `index` segments and normalizes dynamic parameters when matching method/path pairs.

The snapshot excludes these non-API routes:

- `server/routes/__test/durable-job.get.ts`
- `server/routes/auth/bing.get.ts`
- `server/routes/auth/google.get.ts`
- `server/routes/mcp.post.ts`

Admin WebSocket routes are outside the public protocol inventory.
The retired user and partner WebSocket handlers are absent.

A new generic API file without a scanner rule fails validation.
So does a public v1 route without a descriptor, or a v1 descriptor without a route.

## Ownership evidence

The validator reads package route builders, legacy endpoint descriptors, and the three generated v1 OpenAPI files.
It matches them to host handlers by method and normalized path.
Each operation records its producer file, classification, descriptor owners, and route-builder owners.

The [v1 contract](./hosted-api-v1.md) defines protocol behavior.
Updating this inventory does not approve a new public operation.
