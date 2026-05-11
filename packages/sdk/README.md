# @gscdump/sdk

Consumer SDK for hosted gscdump.com integrations.

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

## Scope

- Partner user lifecycle
- Partner site lifecycle
- Data/detail queries
- Analysis presets
- Sitemap and indexing reads
- Webhook receiver contracts and HMAC verification helpers
- Shared request/response types re-exported from `@gscdump/contracts`

Analyzer Source dispatch, browser DuckDB-WASM boot, R2 parquet attach, and
Nuxt composables remain in `@gscdump/nuxt-analytics`. Nuxt apps should install
`@gscdump/nuxt-analytics` for dashboard reads; that layer uses
`createAnalyticsClient()` internally.

## Boundary

`@gscdump/sdk` is a consumer SDK. It must not own gscdump.com producer
behavior.

Belongs here:

- request/response types and schemas for partner apps
- route builders and pluggable HTTP clients
- websocket client and event schemas
- webhook header constants, event schemas, parsing, normalization, and signature
  verification for receivers

Does not belong here:

- deciding when gscdump.com emits webhooks
- queueing, retries, backoff, idempotency, or activity logging
- resolving public user/site IDs from gscdump.com storage
- generating or storing production webhook secrets
- creating production webhook delivery IDs or envelopes
- partner subscription filtering for outgoing deliveries

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
