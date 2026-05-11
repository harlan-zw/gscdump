# @gscdump/contracts

Shared protocol contracts for gscdump.com integrations.

This package contains types, route metadata, Zod schemas, shared storage/query
primitives, event names, and contract versions. It has no HTTP client, no
websocket client, no queueing, and no producer behavior.

Used by:

- `@gscdump/sdk` for consuming gscdump.com
- gscdump.com route/webhook/realtime contract tests
- CLI and MCP integrations that need protocol validation

Producer behavior such as DB reads, auth, queues, webhook delivery, retries,
and storage remains in gscdump.com.
