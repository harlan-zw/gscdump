# @gscdump/contracts

Shared protocol contracts for gscdump.com integrations.

> The executable 18-operation public-v1 registry is exported from
> `@gscdump/contracts/v1`. Existing root route/endpoint exports still describe
> the legacy host during the release and cutover overlap. See the
> [v1 contract](../../docs/hosted-api-v1.md) and
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

Realtime contracts cover credential-inferred streams, tickets, frame bounds,
replay, cumulative ACKs, and resync. A semantic event owns one cursor and a
`changes[]` list, so one terminal transition can invalidate analytics and
lifecycle state atomically. Configurable grants and public resource revisions
are not part of v1; internal RPC/storage revisioning remains a host
implementation concern.
