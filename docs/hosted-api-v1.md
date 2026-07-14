# Hosted API v1 contract freeze

## Status and intent

This is the normative contract for the first public gscdump.com API. The lean
four-operation slice is implemented in the workspace across contracts,
generated artifacts, SDK, hosted adapters, realtime Worker/outbox, generic
`nuxt-use-query` effects, and the app-local NuxtSEO reference integration.
The contract and SDK packages are released as 0.38.0. The host HTTP and
realtime slice is deployed, and direct production canaries cover all four HTTP
operations, single-use tickets, outbox-to-socket delivery, effect-aware cursor
confirmation, duplicate-event suppression, documented idle-hibernation resume,
and the full 15-minute alarm expiry. The isolated NuxtSEO consumer slice is
verified locally, but its production cut is deferred while unrelated consumer
work completes. This status does not claim a legacy cut or public launch. The
checked-in constants are machine-readable in
[`hosted-api-v1-constants.json`](./hosted-api-v1-constants.json), and the
legacy producer evidence is in
[`hosted-api-inventory.md`](./hosted-api-inventory.md).

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative. A
constant change requires a reviewed update to this document and its JSON
companion before implementation changes.

## Public surfaces

The URL carries the surface and major version:

| Surface | Base path | Purpose |
| --- | --- | --- |
| Partner | `/api/partner/v1` | Partner-owned users, teams, sites, and lifecycle control |
| Analytics | `/api/analytics/v1` | Authorized site data and analyzer execution |
| Realtime HTTP | `/api/realtime/v1` | Ticket minting and stream-head reads |
| Realtime WebSocket | `/ws/v1` | Replayable invalidation and lifecycle events |

`/api/__gsc`, `/ws/user`, and `/ws/partner` are legacy producer paths, not v1
aliases. A migration adapter MAY exist temporarily, but public documentation,
contracts, and generated clients MUST use the paths above.

A consumer-side proxy MUST retain both the surface and major in its path. For
example, `/api/gscdump/analytics/v1/...` is acceptable; collapsing it into
unrelated app routes such as `/api/pro/...` is not the public integration
seam. This keeps auth, telemetry, caching, and future cutovers attributable to
the actual upstream contract.

The first public implementation freezes exactly these HTTP operations:

- `GET /api/partner/v1/users/{userId}/lifecycle`
- `POST /api/analytics/v1/sites/{siteId}/rows`
- `POST /api/realtime/v1/tickets`
- `GET /api/realtime/v1/stream/head`

The current legacy filesystem is evidence, not a promise that all 214 hosted
operations become public. Any later partner or analytics operation must pass
the same descriptor, implementation, SDK, and publication gates before it is
added to this list.

## Contract registry and release gate

`@gscdump/contracts` MUST own one executable descriptor for every public v1
operation. A descriptor MUST declare:

- stable operation ID, surface, method, and v1 path;
- `query` or `mutation` semantics;
- accepted credential classes and required scopes;
- resource-ownership checks in addition to scopes;
- request parameters/body schema and success/error schemas;
- consistency requirement;
- idempotency behavior for mutations.

There is no `noSchema` escape hatch in v1. Two logical actions MUST NOT share
one method/path descriptor and rely on an untyped body switch. Producer route,
contract descriptor, SDK method, documentation, and contract test are one
change.

The four accepted v1 descriptors have complete schemas and live hosted routes.
The legacy inventory still records ten schema-less descriptors, two
descriptors with no producer handler, and one collision. Those findings block
promotion of the affected legacy operations; they do not silently expand or
invalidate this four-operation slice. Host-only, session-only, CLI,
public-site, and admin operations should remain out of protocol rather than
receiving accidental contracts.

## Authentication and static scopes

V1 uses `Authorization: Bearer <credential>`. `x-api-key` is legacy-only. A
credential MUST NOT appear in a URL, WebSocket frame, browser state, or log.

Only principal-wide `user_key` and `partner_key` credentials are public v1
credential classes. Their scopes are static class entitlements, not
user-configurable grants:

| Credential | Exact default scopes |
| --- | --- |
| `user_key` | `users:read`, `users:write`, `sites:read`, `sites:write`, `analytics:read`, `analytics:execute`, `indexing:read`, `indexing:write`, `sitemaps:read`, `sitemaps:write`, `settings:read`, `settings:write`, `realtime:connect` |
| `partner_key` | All `user_key` scopes plus `teams:read`, `teams:write` |

For `user_key`, user and settings operations are self-only and site operations
are limited to sites the principal currently owns or may access. For
`partner_key`, user, team, and site operations are limited to resources owned
by or linked to that partner. Every operation requires both the static scope
and its principal/resource ownership check. Possessing a scope never grants
cross-tenant access.

`scoped_key`, `team_key`, `session`, and `cli_token` are outside the initial
public v1 surface and are realtime-ineligible. In particular,
`realtime:connect` is available only on a principal-wide key. Adding another
credential class is a later explicit design decision.

The existing `grantedScopes` fields describe Google OAuth permissions. They
are unrelated to these API entitlements. V1 adds no public grants model.

## Query consistency and mutation completion

Every operation declared as a query and authenticated by `user_key` MUST use a
D1 primary session for its credential lookup, authorization reads, and domain
reads. In the current host this means starting the request's reads with
`withSession('first-primary')`; falling back to a replica inside the same
request is not allowed. This applies to every user-key query, not only snapshot
or realtime endpoints.

Partner-key queries declare their consistency in the descriptor. Realtime
head, resync inputs, post-mutation reads, and authorization-sensitive reads
MUST be primary. An endpoint MUST NOT silently return stale data when its
descriptor promises primary consistency.

A mutation response means its declared synchronous effects completed. If work
continues asynchronously, the endpoint returns `202` with an explicit job
resource; it does not return a successful synchronous shape while dropping an
unawaited effect. Each mutating descriptor declares whether it supports or
requires `Idempotency-Key` and how long the result is replayable.

## HTTP compatibility and errors

Within v1, adding optional fields to a response object is compatible. SDK and
consumer response parsers MUST tolerate unknown object keys while still
validating all known fields. Producer contract tests validate the strict
current response schema, so a producer cannot emit an undocumented field; the
schema and tolerant consumer parser move together. Request objects remain
closed unless a descriptor explicitly says otherwise.

Enum values are closed. Adding, renaming, or changing the meaning of an enum
value is breaking unless the enum already defines an explicit fallback value.
Removing or renaming a field, making an optional field required, changing a
field type or meaning, or changing success status semantics is breaking.

Errors use one object shape:

```json
{
  "error": {
    "code": "stable_machine_code",
    "message": "Human-readable summary",
    "requestId": "opaque-id",
    "retryable": false,
    "details": {}
  }
}
```

Successful JSON uses `{ "data": ..., "meta": ... }`; `meta` contains at
least `requestId`, the surface name, and wire version `1.0`. `code` is stable
and closed for each operation. `message` is not a parsing contract. `details`
is a required object (empty when unused) and is additive. Authentication
failures do not reveal whether a principal or resource exists.

## Rate limits and lifecycle signaling

The hosted policy is one atomic 60-second fixed-window counter per authenticated
principal and operation:

| Operation | Requests per 60 seconds |
| --- | ---: |
| `partner.users.lifecycle.get` | 120 |
| `analytics.rows.query` | 60 |
| `realtime.stream.head.get` | 120 |
| `realtime.tickets.create` | 30 |

Valid credentials consume quota after their static scope is accepted, including
resource-forbidden and failed domain attempts. Malformed requests, invalid keys,
and credentials without the static scope do not consume a principal counter.
Limiter-state failure is fail-closed as retryable `503 internal_error` with
`Retry-After: 5`.

Quota-evaluated responses carry `RateLimit-Policy` and `RateLimit` in the current
HTTPAPI Internet-Draft structured-field form. A rejected attempt returns
`429 rate_limited`; its `Retry-After` value is authoritative while the two
`RateLimit*` fields remain advisory. All v1 responses carry
`GSCdump-API-Version: 1.0`, `Cache-Control: private, no-store`, and
`Vary: Authorization`.

The four initial operations are not deprecated and emit no `Deprecation` or
`Sunset`. A future deprecation must update executable lifecycle metadata,
generated artifacts, and its migration guide first. Runtime signaling then uses
the RFC 9745 `Deprecation: @<unix-seconds>` date form, a `rel="deprecation"`
documentation link, and an RFC 8594 `Sunset` only when removal is committed.

## Realtime identity and ticket exchange

The credential class determines the only stream a caller can receive:

- `user_key` → `user:{credential.userPublicId}`
- `partner_key` → `partner:{credential.partnerPublicId}`

The ticket request body is either `{}` or `{ "origin": "https://host" }`.
It MUST NOT accept a stream, user ID, partner ID, site IDs, filters, scopes, or
cursor. Dynamic subscriptions and partner-on-behalf-of-user sockets are not in
v1. `origin`, when present, is a canonical Origin (`scheme://host[:port]`) with
no credentials, path, query, or fragment and must match the credential's exact
registered allowlist entry.

For a browser connection, the consumer server keeps the long-lived credential
server-side, requests a ticket with the browser's exact registered Origin, and
returns only the short-lived ticket to the browser. The WebSocket upgrade
Origin MUST exactly match the ticket claim. An origin-less ticket is accepted
only for an upgrade that has no Origin header, which is the server-to-server
case.

Tickets use the exact compact format
`gscdump.ticket.v1.<base64url-payload>.<base64url-signature>`. The JSON payload
and HMAC-SHA-256 signature are base64url encoded without padding; the signature
covers the ASCII `gscdump.ticket.v1.<base64url-payload>` bytes. `iss` is
`https://gscdump.com`, `aud` is `https://gscdump.com/ws/v1`, and `iat`, `exp`,
and `connectionExpiresAt` are integer Unix seconds.

```ts
interface TicketClaims {
  v: 1
  iss: 'https://gscdump.com'
  aud: 'https://gscdump.com/ws/v1'
  kid: string
  jti: string
  iat: number
  exp: number
  connectionExpiresAt: number
  principalClass: 'user_key' | 'partner_key'
  principalPublicId: string
  streamId: `user:${string}` | `partner:${string}`
  origin: string | null
}
```

Tickets are single-use, valid for at most 60 seconds, and limited to 2 KiB.
The signed claims are frozen in the constants file; static API scopes and the
consumer's cache scope are intentionally not ticket claims. `jti` MUST contain
at least 128 bits of randomness and is consumed atomically by the target stream
object on upgrade. An `iat` at most five seconds in the future is tolerated for
issuer/verifier skew, but there is no tolerance after the hard `exp` and
`exp - iat` MUST NOT exceed 60 seconds. `connectionExpiresAt` is no later than
15 minutes after issue; the server closes the connection at that time even
though the ticket itself was consumed earlier.

The signing key ring contains a current key and, during rotation, one previous
key. Each signing key contains at least 32 random bytes. Mints always use the
current `kid`. Verification accepts the current and previous keys for 90
seconds after the last possible mint with the old key: the 60-second maximum
ticket lifetime plus a 30-second rollout margin. It then rejects the old or
unknown `kid`. The signing secret is independent from credential hashing and
other application secrets.

The browser opens the socket with these subprotocol tokens:

```ts
[
  'gscdump.v1',
  'gscdump.ticket.v1.<base64url-claims>.<base64url-signature>',
]
```

The server selects `gscdump.v1`; it never echoes the ticket token.
Ticket-bearing `Sec-WebSocket-Protocol` values MUST be redacted from logs. A
ticket never belongs in the URL or an authentication frame.

The ticket HTTP success `data` contains `socketUrl`, protocol `gscdump.v1`,
`protocolVersion: 1`, the compact `ticket`, RFC 3339 `expiresAt`, inferred
`head: { streamId, sequence }`, and `maxConnectionSeconds: 900`. The HTTP
response uses the standard success `meta`; it never returns the long-lived
credential.

## Stream and frame model

One Durable Object owns one exact principal stream. Its persisted sequence is
monotonic per stream. Sequence values are serialized as base-10 strings and
treated as opaque by clients, avoiding a future JSON safe-integer break. A
cursor is the stream ID plus the highest contiguous durable sequence whose
base envelope validated and whose required async effect completed. Delivery is
at least once; event `id` provides idempotent deduplication.

The base server frames are:

```ts
interface StreamCursor {
  streamId: string
  sequence: string // unsigned base-10 integer, opaque to consumers
}

interface HelloFrame {
  type: 'hello'
  protocolVersion: 1
  sdkVersion: string
  resume: StreamCursor | null
}

interface AckFrame {
  type: 'ack'
  cursor: StreamCursor
}

interface ReadyFrame {
  type: 'ready'
  protocolVersion: 1
  connectionId: string
  streamId: string
  head: StreamCursor
  replayFloor: StreamCursor
  limits: { maxBatchEvents: number, maxUnackedEvents: number }
  heartbeat: { ping: 'ping', pong: 'pong' }
  expiresAt: string
}

interface ResourceChange {
  type: string
  id: string
  kind: 'created' | 'updated' | 'deleted'
}

interface EventEnvelope {
  type: 'event'
  protocolVersion: 1
  eventVersion: number
  id: string
  name: string
  cursor: StreamCursor | null
  subject: { type: 'partner' | 'team' | 'user' | 'site', id: string }
  changes: ResourceChange[]
  occurredAt: string
  correlationId: string | null
  delivery: 'durable' | 'ephemeral'
  data: unknown
}
```

The initial public change vocabulary is `partner.user`, `partner.team`,
`user.sites`, `site.registration`, `site.lifecycle`, `site.analytics`,
`site.sitemaps`, `site.indexing`, and `site.auth`. The initial semantic event
registry is:

| Event name | Delivery | Base changes |
| --- | --- | --- |
| `user.lifecycle.changed` | Durable | `partner.user`, `user.sites` |
| `site.lifecycle.changed` | Durable | `site.lifecycle` |
| `site.lifecycle.progress` | Ephemeral | None |
| `site.analytics.ready` | Durable | `site.analytics`, `site.lifecycle` |
| `site.sitemaps.ready` | Durable | `site.sitemaps`, `site.lifecycle` |
| `site.indexing.ready` | Durable | `site.indexing`, `site.lifecycle` |
| `site.auth.failed` | Durable | `site.auth`, `site.lifecycle` |
| `site.lifecycle.failed` | Durable | `site.lifecycle` |
| `site.registration.changed` | Durable | `site.registration`, `user.sites` |

`batch` contains ordered `EventEnvelope` entries. Client frames are `hello`
with the last durably applied `StreamCursor` and cumulative `ack` with the
newest durably applied `StreamCursor`. Server frames are `ready`,
`replay.begin`, `replay.end`, `event`, `batch`, `resync.required`, and `error`.
`resync.required` carries a stable reason, affected public scope, and
`resumeAfter` cursor. No public resource revision or per-resource grant appears
in a frame; `eventVersion` versions only the named event's optional `data`
payload and is a positive integer. V1 resync reasons are `cursor_expired`,
`retention_gap`, `sequence_gap`, and `stream_mismatch`. V1 accepted-socket
error codes are `invalid_frame`, `protocol_mismatch`, `policy_violation`,
`overloaded`, and `internal_error`.

One semantic event can carry several `changes`. For example,
`site.analytics.ready` invalidates both `site.analytics` and `site.lifecycle`.
The base `changes` array is the forward-compatible cache effect contract; the
optional `data` object is never authoritative state. The SDK strictly validates
the base envelope. For an unknown event name or unsupported known
`eventVersion`, it ignores `data`, applies every base change, and emits a
non-fatal upgrade advisory.

Durable events have a cursor, are replayed, and participate in cumulative ACK.
Ephemeral progress is a complete latest snapshot with `cursor: null` and an
empty `changes` array. It may be coalesced or dropped, is never replayed, and
does not advance the durable cursor.

The client MUST send `hello` within 10 seconds. A missing cursor means no safe
resume point and triggers resync. Otherwise the server replays every retained
event after the cursor, in order, before live delivery. If the cursor is older
than the replay window, the server sends `resync.required`; it never skips to
head silently. A stream mismatch or sequence gap also pauses application until
replay or resync establishes a contiguous cursor.

`GET /api/realtime/v1/stream/head` uses the authenticated credential to infer
the same stream and returns `head: { streamId, sequence }`. It accepts no stream
selector. It is the HTTP reconciliation and health seam, not a second event
transport; `replayFloor` is supplied by the accepted socket's `ready` frame.

For SSR, the consumer server captures this head before its primary-consistent
HTTP reads and serializes the resulting watermark with query state. After
hydration, `hello` resumes after that cursor, closing the read-to-socket gap.
A pure client entry with no watermark captures `ready.head`, performs the full
unsafe resync while event application is paused, and only then resumes after
the captured head.

Events are invalidation facts, not authoritative resource snapshots. The
source mutation and a durable outbox record MUST commit together. Dispatch to
the stream is idempotent by event `id`. A delete, unlink, or transfer captures
the audience before and after mutation in the outbox and targets the union, so
both the old and new principal caches are invalidated after ownership changes.
Resolving audiences only after the mutation is incorrect because the old
relationship may already be gone.

## Replay, size, heartbeat, and lag bounds

| Constant | Frozen value | Reason |
| --- | ---: | --- |
| Replay age | 24 hours | Covers normal sleep, deploy, and short outage windows; events are still only invalidations |
| Replay count | 10,000 events per stream | Bounds a noisy tenant even inside 24 hours |
| Client frame | 16 KiB | `hello`, `ack`, and heartbeat need nowhere near platform limits |
| Durable event | 64 KiB | Keeps invalidations small and well below a Durable Object SQLite row limit |
| Ephemeral event | 16 KiB | Progress is a coalescible latest snapshot, not a data transport |
| Outbound frame/batch | 256 KiB | Bounds per-socket allocation and latency |
| Batch count | 20 events | Keeps replay responsive instead of building large frames |
| Hibernation attachment | 2 KiB | Stores only cursor/principal state |
| Heartbeat | `ping` every 25 seconds; stale after 75 seconds | Three missed heartbeats before reconnect |
| Soft ACK lag | 100 events or 1 MiB | Pause delivery and coalesce non-durable work |
| Hard ACK lag | 500 events or 4 MiB | Close with `1013`; reconnect must replay or resync |

Age and count limits both apply; pruning either limit advances
`replayFloor`. Count and byte thresholds use serialized durable event sizes.
The server pauses new delivery at the soft threshold. The stream may continue
to append events, so reaching the hard threshold closes the slow consumer
instead of growing per-connection state indefinitely.

Heartbeat payloads are the literal strings `ping` and `pong`, allowing a
Durable Object hibernation auto-response without waking application code.
Reconnect uses equal-jitter exponential backoff from 1 to 30 seconds. The
client obtains a new ticket for every new socket and rotates a healthy socket
30 seconds before its connection expiry.

Accepted-socket close policy is stable:

| Code | Meaning | SDK action |
| ---: | --- | --- |
| `1000` | Normal/manual | Stop |
| `1002` | Malformed or incompatible protocol | Terminal until SDK update |
| `1008` | Stream/frame policy violation | Terminal |
| `1011` | Internal failure | Jittered reconnect with a fresh ticket |
| `1012` | Service restart/deploy | Jittered reconnect with a fresh ticket |
| `1013` | Overload or hard ACK lag | Honor `retryAfter`; replay or resync if below floor |
| `4001` | Maximum connection lifetime | Fresh ticket and cursor resume |

A pre-acceptance browser upgrade failure is normally observable only as an
opaque error/`1006`. The SDK reports `upgrade_rejected`, discards that ticket,
and does not invent an auth, Origin, or replay diagnosis from unavailable HTTP
details. A JSON protocol error's optional `retryAfter` is an integer number of
seconds. All byte limits measure the UTF-8 serialized frame or envelope.

These application limits are intentionally far below Cloudflare's platform
ceilings: incoming WebSocket messages currently allow 32 MiB, Durable Object
SQLite strings/BLOBs allow 2 MB, and serialized WebSocket attachments allow
16,384 bytes. Small protocol bounds protect the Worker's 128 MB isolate and
make replay latency predictable. See Cloudflare's
[WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## ACKs, rejected effects, and safe cache integration

An ACK is a correctness boundary, not a receipt callback. For each durable
event, the
SDK MUST:

1. deduplicate by event `id` and cursor without advancing beyond an unapplied sequence;
2. await the required `applyEvent` effect;
3. persist the new cursor locally;
4. send the cumulative ACK;
5. notify observational listeners.

If `applyEvent` rejects, the SDK retains the previous cursor and sends no ACK.
It closes/reconnects and retries that sequence. After three failures of the
same event, it attempts the unsafe-resync procedure below. A rejected resync
also sends no ACK and surfaces a terminal integration error; it is never
converted into success by a `finally` block or fire-and-forget callback.

For `nuxt-use-query`, the host supplies the SDK with an opaque, host-owned
`cacheScope` epoch. It is local consumer state, not a ticket request field,
ticket claim, or server frame. Every known entry in `changes` maps to explicit
query keys, and the single required event effect awaits all of their
purge/invalidation and primary-backed reseed work. An unknown resource change
MUST purge its whole `subject` keyspace before ACK; it must not be ignored
because the installed consumer predates that resource. If the subject is
missing or cannot be mapped safely, the event is unsafe.

Unsafe resync MUST purge the entire opaque `cacheScope`, then primary-reseed
the authoritative queries needed by the mounted application. Only after that
promise resolves may the client adopt `resumeAfter` and reconnect/resume from
the advertised head. This is also the required response to `resync.required`,
an absent initial cursor, an unrecoverable event mapping, or an event apply
failure threshold.

The Nuxt bridge may use `useNuxtSubscription` for lifecycle/status exposure,
but the SDK's awaited apply/resync hooks own cursor advancement. A callback
that merely pushes an event into an asynchronous subscription queue is not a
completed effect and cannot authorize an ACK.

The `nuxt-use-query` bridge therefore needs promise-bearing effects:

- durable `ctx.push(raw)` serializes delivery and resolves only after its async
  `onMessage` work succeeds;
- `ctx.resync(request)` awaits async `onResync` and propagates rejection;
- whole-scope removal deletes inactive and active cached data without refetch,
  then only currently active views are primary-reseeded;
- invalidation rejects if any required active refresh settles in an error
  state;
- teardown or cache-scope rotation rejects queued work with `AbortError`
  instead of resolving it as applied.

The host rotates `cacheScope`, closes realtime, and removes the old
scope/cursor whenever principal or authorization changes. Its session payload
contains only opaque principal/cache scope, surface-aware proxy metadata,
ticket metadata, and the SSR watermark—never a gscdump key.

An HTTP descriptor's `query`/`mutation` kind is independent of method. An
idempotent analytics `POST` query remains a `defineNuxtRpcQuery`, and its
validated canonical body participates automatically in the cache key and SSR
payload. It must not be modeled as a mutation merely because it uses `POST`.

## Internal RPC and storage revisions

Public v1 has no resource revision system. Internal service RPC DTOs and
persisted event envelopes instead carry mandatory integer `revision: 1`.
Writers emit only the current revision. During a rolling deploy, readers accept
the current and immediately previous revision; any other value fails with
`unsupported_internal_revision`. Because 1 is the first revision, revision-1
readers accept only 1; the previous-revision window begins with revision 2 and
never makes an unversioned or revision-0 payload valid.

Rollouts use expand/read/write/cleanup order:

1. deploy readers that accept old and new internal DTOs;
2. deploy writers that emit the new revision;
3. wait until no old writer or queued old payload remains;
4. remove old-read compatibility.

Durable Object SQLite schema migrations use an independent monotonically
increasing migration number. They are not the public protocol major or the
internal RPC revision. Destructive cleanup happens only after every deployed
reader is compatible with the expanded schema.

## Explicitly deferred

V1 does not add public configurable grants, per-resource revisions, dynamic
WebSocket filters, team/scoped credentials, arbitrary stream selection, or a
generic public operation passthrough. Any of these requires a new evidence-led
design; none should be pre-scaffolded into the first implementation.

The released package and deployed host agree on the four-operation registry.
Contract, Workerd, and production canaries cover the host and transport gates;
the production canaries include credentialed primary reads, single-use
tickets, queue-to-socket delivery, effect-aware ACK cursor confirmation, and
duplicate outbox suppression.

Before public documentation is opened, the deferred NuxtSEO production cut
must still prove an authenticated browser refresh through its proxy and the
absence of long-lived gscdump keys from browser payloads. Protected host run
`29324725739` closed the idle-hibernation/full-lifetime gate without product
mutation. Production failure drills for replay expiry, backpressure, and
ticket-key rotation remain publication evidence even though their deterministic
contract and Workerd coverage is green.
