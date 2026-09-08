# @gscdump/sdk

Consumer SDK for hosted gscdump.com integrations.

Use `@gscdump/sdk/v1` for hosted HTTP and realtime clients.
The package root has no export.
Keep long-lived credentials on your server.

```bash
npm install @gscdump/sdk
```

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
operation executor plus typed convenience methods for all 55 registered HTTP
operations across partner, analytics, and realtime.

Focused guides:

- [Quickstart](../../docs/guides/hosted-v1.md#quickstart)
- [Authentication](../../docs/guides/hosted-v1.md#authentication)
- [Errors](../../docs/guides/hosted-v1.md#errors)
- [Rate limits](../../docs/guides/hosted-v1.md#rate-limits)
- [Idempotency and retries](../../docs/guides/hosted-v1.md#idempotency-and-retries)
- [Realtime](../../docs/guides/hosted-v1.md#realtime)
- [Upgrade guide](../../docs/v1-migration.md)

`createPartnerClient` remains at `@gscdump/sdk/partner` only for operations
still in the compatibility inventory. Do not use it for an operation already
available from `@gscdump/sdk/v1`.

Use focused subpaths for pure helpers, including `period`, `period-presets`,
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

## Browser integration

Keep `user_key` and `partner_key` credentials on your server.
Expose a same-origin proxy that preserves the upstream surface and major version, such as `/api/gscdump/analytics/v1/...`.
The browser receives a single-use realtime ticket.

Your `applyEvent` callback must await every cache change before the SDK advances its cursor or sends an ACK.
Your `resync` callback must clear the affected cache scope and reload authoritative state.
See the [realtime guide](../../docs/guides/hosted-v1.md#realtime) for the client hooks.

The SDK provides HTTP transport, realtime state, and webhook receiver helpers.
Your application owns authentication, caching, and UI integration.
gscdump.com owns webhook delivery, queues, and storage.

## Webhooks

`@gscdump/contracts` owns the webhook payload schema and event constants.
`@gscdump/sdk` provides receiver-side helpers to parse the payload, verify the
signature, and normalize event names. gscdump.com owns webhook production and
delivery.

```ts
import { parseWebhookPayload } from '@gscdump/sdk/webhook'

const envelope = await parseWebhookPayload(await request.text(), {
  secret: webhookSecret,
  signature: request.headers.get('x-gscdump-signature'),
})
```
