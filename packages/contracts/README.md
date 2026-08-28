# @gscdump/contracts

Shared protocol contracts for gscdump.com integrations.

> The executable public v1 registry is exported from
> `@gscdump/contracts/v1`. Existing root route/endpoint exports still describe
> the legacy host during the release and cutover overlap. See the
> [integration guide](../../docs/guides/hosted-v1.md),
> [v1 contract](../../docs/hosted-api-v1.md), and
> [producer inventory](../../docs/hosted-api-inventory.md).

This package contains types, route metadata, Zod schemas, shared storage/query
primitives, event names, and contract versions. It has no HTTP client, no
websocket client, no queueing, and no producer behavior.

Used by:

- `@gscdump/sdk` for consuming gscdump.com
- gscdump.com route/webhook/realtime contract tests
- CLI and MCP integrations that need protocol validation

Producer behavior such as DB reads, auth, queues, webhook delivery, retries,
and storage remains in gscdump.com.

## Public v1 bar

Each public operation has one executable descriptor covering its
surface/version, method/path, query or mutation semantics, credential classes,
static scopes, ownership policy, request/response schemas, consistency,
idempotency, and errors. V1 has no schema-less descriptor and no two logical
operations sharing an ambiguous method/path.

Response object schemas are additive for consumers: parsers accept unknown
object keys while validating known fields. Producer contract tests remain
strict against the documented current schema, and enum values remain closed.
Every `user_key` query declares primary read consistency with no caller
override.

Framework adapters use the registry mechanics exported from
`@gscdump/contracts/v1/http`:

- `listHttpOperations(protocol)` produces the canonical surface/operation
  entries used by SDK indexes and producer parity checks.
- `resolveHttpOperation(entries, request)` matches an exact method, surface,
  and surface-relative path; it decodes and parses path parameters through the
  descriptor, rejects unsafe segments, and returns the canonical path.

Consumer authorization stays app-owned. A browser proxy selects its explicit
operation-ID allowlist, then passes only those entries to the resolver.

Consumers that only need operation metadata and paths can avoid the schema
runtime:

```ts
import { createGscdumpV1Paths } from '@gscdump/contracts/v1/paths'

const paths = createGscdumpV1Paths({ apiRoot: '/api/_gscdump' })
const url = paths.path('analytics.rows.query', { siteId: 's_01' })
```

The subpath has no Zod dependency. It encodes each path parameter as one URL
segment. Callers own query string construction and validation.

Generated contract files:

- [Partner OpenAPI](./generated/openapi.partner.v1.json)
- [Analytics OpenAPI](./generated/openapi.analytics.v1.json)
- [Realtime HTTP OpenAPI](./generated/openapi.realtime.v1.json)
- [Realtime AsyncAPI](./generated/asyncapi.realtime.v1.json)

Focused guides:

- [Quickstart](../../docs/guides/hosted-v1.md#quickstart)
- [Authentication](../../docs/guides/hosted-v1.md#authentication)
- [Errors](../../docs/guides/hosted-v1.md#errors)
- [Rate limits](../../docs/guides/hosted-v1.md#rate-limits)
- [Idempotency and retries](../../docs/guides/hosted-v1.md#idempotency-and-retries)
- [Realtime](../../docs/guides/hosted-v1.md#realtime)
- [Upgrade guide](../../docs/v1-migration.md)

Realtime contracts cover credential-inferred streams, tickets, frame bounds,
replay, cumulative ACKs, and resync. A semantic event owns one cursor and a
`changes[]` list, so one terminal transition can invalidate analytics and
lifecycle state atomically. Configurable grants and public resource revisions
are not part of v1; internal RPC/storage revisioning remains a host
implementation concern.
