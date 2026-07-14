# @gscdump/sdk

Consumer SDK for hosted gscdump.com integrations.

> The descriptor-driven HTTP client and ticketed realtime state machine are
> exported from `@gscdump/sdk/v1`. Existing root HTTP/realtime clients remain
> legacy compatibility surfaces during the release and cutover overlap; the
> legacy socket client still sends a long-lived key in its first frame and must
> not be used for a v1 browser integration. See the
> [v1 contract](../../docs/hosted-api-v1.md).

This package is for partner applications that consume gscdump.com APIs,
webhooks, and realtime events. Callers inject the HTTP transport and auth they
want to use; route construction stays inside the hosted adapter.

```ts
import { createGscdumpClient } from '@gscdump/sdk'

const gscdump = createGscdumpClient({
  apiBase: 'https://example.com/api',
  apiKey: process.env.GSCDUMP_API_KEY,
  fetch: $fetch,
})

const { sites } = await gscdump.getUserSites(userId)
```

The initial v1 slice uses a server-held Bearer credential and exposes both a
generic operation executor and four convenience methods:

```ts
import { createGscdumpV1Client } from '@gscdump/sdk/v1'

const gscdump = createGscdumpV1Client({
  credential: () => process.env.GSCDUMP_API_KEY!,
  fetch,
})

const lifecycle = await gscdump.getUserLifecycle({
  params: { userId: 'u_01' },
})
```

## Scope

- Partner user lifecycle
- Partner site lifecycle
- Data/detail queries
- Analysis presets
- Sitemap and indexing reads
- Webhook receiver contracts and HMAC verification helpers
- Shared request/response types re-exported from `@gscdump/contracts`

Analyzer Source dispatch, browser DuckDB-WASM boot, and R2 parquet attach are
separate engine/Nuxt concerns. A Nuxt app can consume the hosted SDK through
its own query layer; the current consumer uses `nuxt-use-query` rather than
making the public API depend on `@gscdump/nuxt`.

For v1, a Nuxt consumer keeps `user_key` and `partner_key` credentials on its
server and exposes proxy paths that retain the upstream surface and major
(for example `/api/gscdump/analytics/v1/...`). Browser realtime receives only
a single-use ticket. Every semantic event's `changes[]` maps to one ordered,
awaited query-cache effect; unsafe resync purges the whole host-owned cache
scope and primary-reseeds it before the SDK advances its cursor or ACKs.

## Boundary

`@gscdump/sdk` is a consumer SDK. It must not own gscdump.com producer
behavior.

Belongs here:

- request/response types and schemas for partner apps
- route builders and pluggable HTTP clients
- ticketed websocket client, replay/resync state, and event schemas
- awaited realtime apply/resync hooks; a rejected effect never advances ACK
- webhook header constants, event schemas, parsing, normalization, and signature
  verification for receivers

Does not belong here:

- deciding when gscdump.com emits webhooks
- queueing, retries, backoff, idempotency, or activity logging
- resolving public user/site IDs from gscdump.com storage
- generating or storing production webhook secrets
- creating production webhook delivery IDs or envelopes
- partner subscription filtering for outgoing deliveries
- Durable Object stream storage, replay retention, or outbox dispatch

## Webhooks

`@gscdump/contracts` owns the webhook payload schema and event constants.
`@gscdump/sdk` provides receiver-side helpers to parse the payload, verify the
signature, and normalize event names. gscdump.com owns webhook production and
delivery.

```ts
import { parseWebhookPayload } from '@gscdump/sdk'

const envelope = await parseWebhookPayload(rawJson, {
  secret: webhookSecret,
  signature: request.headers.get('x-gscdump-signature'),
})
```
