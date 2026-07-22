# @gscdump/sdk

Consumer SDK for hosted gscdump.com integrations.

> The descriptor-driven HTTP client and ticketed realtime state machine are
> exported from `@gscdump/sdk/v1`. The root HTTP client remains a temporary
> compatibility surface during the release and cutover overlap; the unsafe
> long-lived-key realtime client was removed before v1. See the
> [v1 contract](../../docs/hosted-api-v1.md).

This package is for partner applications that consume gscdump.com APIs,
webhooks, and realtime events. Callers inject the HTTP transport and auth they
want to use; route construction stays inside the hosted adapter. New hosted
HTTP integrations should import the stable v1 client:

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

The v1 surface uses a server-held Bearer credential and exposes a generic
operation executor plus typed convenience methods for all 18 registered HTTP
operations across partner, analytics, and realtime.

The root `createPartnerClient` export remains only for operations still in the
compatibility inventory. Do not use it for an operation already available from
`@gscdump/sdk/v1`.

The root is also a compatibility aggregate for the pure helper modules. New
code should use the focused subpaths, including `period`, `period-presets`,
`site-triage`, `site-baseline`, `search-console-stage`, `indexing-issues`,
`analytics`, `partner`, `partner-errors`, `lifecycle`, `webhook`, and
`gsc-console-url`.

For example, a typed hosted report query is:

```ts
const report = await gscdump.queryAnalyticsReport({
  params: { siteId: 's_01' },
  body: { state: { dimensions: ['query'], searchType: 'web' } },
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
import { parseWebhookPayload } from '@gscdump/sdk/webhook'

const envelope = await parseWebhookPayload(rawJson, {
  secret: webhookSecret,
  signature: request.headers.get('x-gscdump-signature'),
})
```
