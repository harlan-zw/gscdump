# @gscdump/contracts

Shared protocol contracts for gscdump.com integrations.

Use `@gscdump/contracts/v1` for operation definitions, request and response schemas, and protocol constants.
The registry describes 55 HTTP operations and the realtime protocol.
For HTTP calls, install [`@gscdump/sdk`](../sdk/README.md).

```bash
npm install @gscdump/contracts
```

The root also exports shared types and legacy route metadata.
Use the [v1 guide](../../docs/guides/hosted-v1.md) for new integrations.
The [producer inventory](../../docs/hosted-api-inventory.md) records remaining legacy mismatches.

## Operation contracts

Each operation has one descriptor with its method, path, schemas, credentials, scopes, ownership rules, consistency, and retry behavior.
Descriptors distinguish queries from mutations independently of HTTP method.
Every public operation has schemas and a unique method/path pair.

Response object schemas are additive for consumers: parsers accept unknown
object keys while validating known fields. Producer contract tests remain
strict against the documented current schema, and enum values remain closed.
Every `user_key` query declares primary read consistency with no caller
override.

Framework adapters use
`@gscdump/contracts/v1/http`:

- `listHttpOperations(protocol)` produces the canonical surface/operation
  entries used by SDK indexes and producer parity checks.
- `resolveHttpOperation(entries, request)` matches an exact method, surface,
  and surface-relative path; it decodes and parses path parameters through the
  descriptor, rejects unsafe segments, and returns the canonical path.

Your application owns authorization.
A browser proxy must pass only its allowed operations to the resolver.

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
