# Hosted API v1 integration guide

The hosted v1 API has 58 HTTP operations: 53 partner, three analytics, and two
realtime HTTP operations. The HTTP wire version is `1.0`.

Use these generated files to inspect exact paths, inputs, responses, scopes,
ownership rules, errors, and retry semantics:

- [Partner OpenAPI](../../packages/contracts/generated/openapi.partner.v1.json)
- [Analytics OpenAPI](../../packages/contracts/generated/openapi.analytics.v1.json)
- [Realtime HTTP OpenAPI](../../packages/contracts/generated/openapi.realtime.v1.json)
- [Realtime AsyncAPI](../../packages/contracts/generated/asyncapi.realtime.v1.json)

The generated files come from the executable `@gscdump/contracts/v1` registry.
The [v1 contract](../hosted-api-v1.md) defines behavior shared by every operation.

## Quickstart

Install the hosted SDK in your server application:

```bash
pnpm add @gscdump/sdk
```

Keep the credential in server-side secret storage. This read-only example uses
the default `https://gscdump.com/api` root:

```ts
import { createGscdumpV1Client } from '@gscdump/sdk/v1'

const gscdump = createGscdumpV1Client({
  credential: () => process.env.GSCDUMP_API_KEY!,
})

const lifecycle = await gscdump.getUserLifecycle({
  params: { userId: 'u_01' },
})

console.log(lifecycle.data.account.status)
```

Each registered operation has a typed convenience method. You can also call
the operation ID directly:

```ts
const lifecycle = await gscdump.execute<'partner.users.lifecycle.get'>(
  'partner.users.lifecycle.get',
  { params: { userId: 'u_01' } },
)
```

The client validates request and response payloads against the same contracts
used to generate OpenAPI.

## Authentication

Send the credential as `Authorization: Bearer <credential>`. `x-api-key`
belongs to the compatibility API and is not accepted as v1 authentication.

V1 has two credential classes:

- `user_key` can access its own user and authorized sites.
- `partner_key` can access users, teams, and sites linked to its partner
  tenant.

Every operation checks the credential class, its static scopes, and resource
ownership. The OpenAPI `security`, `x-gscdump-scopes`, and
`x-gscdump-ownership` fields show the exact rule for an operation.

Never put a credential in a URL, browser bundle, browser storage, WebSocket
frame, or log. A browser application should call a same-origin server proxy
that holds the credential. Keep the upstream surface and major version visible
in the proxy path, such as `/api/gscdump/analytics/v1/...`.

## Errors

API failures use one JSON envelope:

```json
{
  "error": {
    "code": "site_not_found",
    "message": "Site not found",
    "requestId": "req_01",
    "retryable": false,
    "details": {}
  }
}
```

Branch on `code` and `retryable`. Treat `message` as display text. Include
`requestId` when reporting a failure. The SDK exposes the same fields through
`GscdumpV1Error`:

```ts
import {
  createGscdumpV1Client,
  isGscdumpV1Error,
} from '@gscdump/sdk/v1'

const gscdump = createGscdumpV1Client({
  credential: () => process.env.GSCDUMP_API_KEY!,
})

const result = await gscdump.getSiteIndexing({
  params: { siteId: 's_01' },
  query: {},
}).catch((error: unknown) => {
  if (isGscdumpV1Error(error)) {
    console.error(error.code, error.requestId, error.retryable)
    return null
  }
  throw error
})
```

Each OpenAPI operation lists its closed API error set in
`x-gscdump-errors`. The SDK also reports local credential, request,
transport, and response validation failures with the same tagged error class.

Successful responses use `{ "data": ..., "meta": ... }`. `meta` includes the
request ID, surface, and wire version. Every HTTP response also carries
`x-request-id`, `GSCdump-API-Version: 1.0`, `Cache-Control: private, no-store`,
and `Vary: Authorization`.

## Rate limits

The host keeps one atomic 60-second fixed-window counter per authenticated
principal and operation. Limits range from 10 to 120 requests per window. The
[rate-limit table](../hosted-api-v1.md#rate-limits-and-lifecycle-signaling)
lists all 55 operation policies.

Quota-evaluated responses include `RateLimit-Policy` and `RateLimit`. On
`429 rate_limited`, wait for the `Retry-After` duration. Treat it as
authoritative. If the limiter is unavailable, the host fails closed with a
retryable `503 internal_error` and `Retry-After: 5`.

The SDK honors `Retry-After` when the operation descriptor allows a retry.

## Idempotency and retries

The OpenAPI `x-gscdump-semantics` object records whether an operation is
idempotent and whether the SDK may retry it. The current registry contains 51
idempotent operations: 36 queries and 15 mutations.

Four mutations are non-idempotent and use `retry: "never"`:

- `partner.sites.indexing.inspect.create`
- `partner.sites.sitemaps.action.create`
- `partner.teams.create`
- `realtime.tickets.create`

The SDK does not automatically retry those four operations. After an ambiguous
network failure, read authoritative state before deciding whether to issue
another mutation. A realtime reconnect always requests a new ticket because
tickets are single-use.

For operations marked `retry: "idempotent"`, the SDK defaults to three total
attempts and caps configuration at five. It retries network failures and API
errors whose envelope says `retryable: true`. The backoff starts at 250 ms,
caps at two seconds, and waits longer when `Retry-After` requires it.

V1 currently has no public result-replay contract for `Idempotency-Key`. A
client-supplied key does not make a non-idempotent operation safe to retry.

## Realtime

The browser receives a short-lived, single-use ticket. It never receives the
long-lived Bearer credential.

1. Your server calls `realtime.tickets.create` with `{}` or the browser's exact
   registered Origin.
2. The browser opens `socketUrl` with `gscdump.v1` and the ticket as its two WebSocket subprotocols.
3. The client applies each durable event before it advances its cursor or
   acknowledges the event.
4. If replay is unsafe, the client runs a full authoritative resync before it
   reports fresh state.

`createGscdumpRealtimeV1Client` owns ticket rotation, replay, cumulative ACKs,
heartbeat checks, reconnect backoff, and the 15-minute connection lifetime.
You provide the application-specific effects:

```ts
import {
  createGscdumpRealtimeV1Client,
  createGscdumpV1Client,
} from '@gscdump/sdk/v1'

const http = createGscdumpV1Client({
  credential: () => process.env.GSCDUMP_API_KEY!,
})

const realtime = createGscdumpRealtimeV1Client({
  ticketProvider: () => http.createRealtimeTicket({ body: {} }),
  // Implement these hooks in your application.
  applyEvent: async (event) => {
    await invalidateResources(event.changes)
  },
  resync: async () => {
    await reloadAuthoritativeState()
  },
})

await realtime.start()
```

This example runs on the server.
For browsers, make `ticketProvider` call your same-origin server ticket endpoint.
That endpoint must request a ticket with the browser's exact registered Origin. See the [Realtime AsyncAPI](../../packages/contracts/generated/asyncapi.realtime.v1.json)
for frames and the [realtime contract](../hosted-api-v1.md#realtime-identity-and-ticket-exchange)
for ticket, replay, ACK, resync, and close-code rules.

## Upgrade from compatibility clients

For an operation present in the generated v1 registry:

1. Import `createGscdumpV1Client` from `@gscdump/sdk/v1`.
2. Replace `x-api-key` with a server-side Bearer credential.
3. Use `/api/partner/v1`, `/api/analytics/v1`, or `/api/realtime/v1`.
4. Switch to the v1 success and error envelopes.
5. Apply the operation's generated scope, ownership, consistency, and retry
   rules.
6. Remove the compatibility call after the consumer passes against the
   deployed v1 route.

Use v1 operations for new integrations.
The legacy `createPartnerClient` and `createAnalyticsClient` exports remain in the package, but many host routes have been removed.
Check the [producer inventory](../hosted-api-inventory.md) before relying on a legacy call.

See [v1 breaking changes and migration](../v1-migration.md) for package export
moves and the hosted client cutover.
