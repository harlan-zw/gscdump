# ADR-0011: Hosted gscdump strategy and package boundaries

## Status

Accepted, amended 2026-07-21. The registry now has 51 operations in the
checked-in `1.4.11` packages and is deployed by the hosted producer. The HTTP
wire version remains `1.0`. The original four-operation slice has full direct
production canary evidence, including idle-hibernation resume and full
15-minute alarm expiry. Expanded-operation canaries, the coordinated NuxtSEO
production handoff, and per-route zero-use evidence remain required before any
predecessor compatibility route can be removed.

## Context

The package set serves three related surfaces:

- **gscdump.com origin** owns user/site registration, credential exchange,
  sync, R2/Iceberg/DuckDB data, hosted APIs, realtime production, webhooks, and
  billing/account decisions.
- **Consumer apps**, currently `nuxtseo.com`, own product UX, sessions,
  credential custody, route composition, cache policy, and lifecycle
  interpretation. Its query integration is built on `nuxt-use-query`.
- **Local/agent workflows** use `gscdump` and `@gscdump/cli` for local
  sync/query/report flows. They are not automatically public hosted API
  operations.

The original ADR correctly separated partner control-plane behavior from
analytics data-plane behavior, but fixed the analytics surface at
`/api/__gsc/*`, treated `/ws/user` and `/ws/partner` as the realtime contract,
and assumed a Nuxt package would own consumer API reads. Before documenting
and opening the API, the initial producer audit found a much larger and less
uniform legacy surface: 210 hosted operations versus 64 package descriptors,
including ten schema-less descriptors, two descriptors without handlers, and
one method/path collision. The live inventory now records 255 operations,
including the 51 accepted v1 routes.

Breaking changes are allowed now. This amendment establishes the small,
versioned target before Worker and SDK implementation.

## Decision

### 1. Public API surfaces are lean and URL-versioned

The target public surfaces are:

- `/api/partner/v1`: partner lifecycle/control plane;
- `/api/analytics/v1`: authorized analytics/data plane;
- `/api/realtime/v1`: realtime ticket and stream-head HTTP operations;
- `/ws/v1`: one credential-inferred realtime transport.

The partner and analytics domains remain separate, but
`/api/__gsc`, `/ws/user`, and `/ws/partner` are legacy implementation paths.
They do not define v1 and are not preserved as public aliases. A consumer
proxy must retain the upstream surface and major in its own path, even if it
adds an app namespace.

The actual host inventory in
[`../hosted-api-inventory.md`](../hosted-api-inventory.md) is the migration
input. Existing routes are included because they exist, not because they are
approved for v1. Admin, CLI, session, public-site, and other host-only routes
remain outside the public protocol unless an explicit later decision moves
them.

### 2. `@gscdump/contracts` owns an executable operation registry

Every accepted v1 operation has exactly one descriptor with method/path,
surface, query/mutation semantics, accepted credential classes, static scopes,
ownership policy, request and response schemas, consistency, idempotency, and
error contracts. There is no v1 `noSchema` escape hatch and no ambiguous pair
of logical operations on the same method/path.

Producer route, descriptor, SDK method, docs, and contract tests change
together. The checked-in inventory validator prevents producer routes and
legacy descriptors from drifting invisibly while the v1 set is selected.

### 3. Authentication is credential-class based and consistency is explicit

The initial public credential classes are principal-wide `user_key` and
`partner_key`. Their exact static scopes are frozen in
[`../hosted-api-v1.md`](../hosted-api-v1.md). Scopes are class entitlements,
not configurable grants, and are always combined with principal/resource
ownership checks. `scoped_key`, `team_key`, `session`, and `cli_token` are
outside public v1 and cannot connect to realtime.

Every user-key query uses primary D1 consistency for authentication,
authorization, and domain reads, with no caller override. Partner queries
declare consistency per operation; authorization-sensitive, post-mutation,
realtime head, and resync reads are primary.

Within v1, response objects are additive: consumer parsers tolerate unknown
object keys while producer tests enforce the documented current schema. Enum
values remain closed. Requests remain closed unless an operation explicitly
documents otherwise.

### 4. Realtime is one exact stream with replay and effect-aware ACKs

`POST /api/realtime/v1/tickets` accepts only an optional exact Origin.
Credential identity infers the stream:

- `user_key` → that user's principal-wide stream;
- `partner_key` → that partner's principal-wide stream.

Clients cannot select a user, partner, site filter, scope, or arbitrary stream.
The long-lived credential stays on the consumer server. A browser receives a
single-use, short-lived signed ticket and sends it through the WebSocket
subprotocol, never the URL or an auth frame.

One Durable Object owns sequence, replay, connection state, and backpressure
for one stream. The v1 replay window, frame/event/batch bounds, heartbeat,
timeouts, ACK thresholds, ticket claims and rotation, and internal RPC/storage
revision policy are frozen in
[`../hosted-api-v1-constants.json`](../hosted-api-v1-constants.json).

Events are durable invalidations, not authoritative snapshots. The source
mutation and outbox record commit together. Delete, unlink, and transfer
outbox rows capture both the old and new audiences; dispatch targets their
union so neither side retains stale cache state.

The public envelope is semantic: `id`, `name`, protocol/event versions, an
exact stream cursor, subject, and `changes[]`. One event can invalidate several
resource families (for example analytics and lifecycle). Unknown compatible
event payloads still execute their version-stable base changes; the protocol
does not flatten them into one resource/action pair.

The SDK advances its cursor and sends a cumulative ACK only after the required
async application effect resolves. Rejection retains the cursor and sends no
ACK. Unknown resources purge their subject; unsafe or out-of-window resync
purges the consumer's entire host-owned cache scope and primary-reseeds before
ACK. Observational listeners run only after this correctness boundary.

### 5. `@gscdump/sdk` is the framework-agnostic public client

`@gscdump/sdk` owns typed HTTP transport, route construction, response
validation, webhook receiver helpers, realtime ticket/socket/replay behavior,
and awaited apply/resync hooks. It does not own producer queues, outboxes,
storage, billing, credential exchange, or a Nuxt cache.

`nuxtseo.com` consumes the SDK behind server proxy routes and maps SDK
apply/resync hooks to `nuxt-use-query`. `useNuxtSubscription` may expose
status and event observations, but an asynchronous queue push is not the
required applied effect and cannot advance the realtime ACK cursor.

Nuxt-specific engine and browser analysis features belong to consumer layers.
The former `@gscdump/nuxt` package was removed after both production consumers
moved to app-owned integration.

### 6. Host and Cloudflare behavior stays behind the protocol

gscdump.com owns credential validation, CORS/Origin policy, primary D1
sessions, operation authorization, rate limiting, source transactions,
outboxes, Durable Object routing/storage, queues, retries, billing gates, and
production telemetry.

`@gscdump/cloudflare` may provide reusable Cloudflare primitives, but it does
not become the public API contract. Internal service DTOs and stored event
envelopes use a rolling internal integer revision; Durable Object SQLite
migrations use a separate monotonic schema version. Neither is a public
resource revision.

### 7. Public grants and resource revisions are deferred

V1 deliberately does not add configurable grants, per-resource revisions,
dynamic WebSocket filters, arbitrary streams, scoped/team credentials, or a
generic passthrough for every host route. Existing `grantedScopes` fields
remain Google OAuth scope evidence and are unrelated to API authorization.

## Consequences

- The original ADR's `/api/__gsc` analytics paths and two legacy socket paths
  are superseded operation by operation as each v1 route completes its rollout gate.
- Current root `partnerRoutes`, `analyticsRoutes`, endpoint descriptors, and
  SDK clients remain legacy migration inputs. The separate
  `@gscdump/contracts/v1` and `@gscdump/sdk/v1` exports own the accepted surface.
- Public API work starts by resolving the inventory, not by wrapping every
  producer file.
- The only consumer can migrate with breaking changes before v1 is opened.
  Its app-local reference integration now keeps the long-lived credential
  server-side; deployment verification must still prove it never crosses a
  browser payload or request.
- Realtime integration is complete only when reconnect, replay, resync,
  primary reseed, cache invalidation, rejected effects, backpressure, ticket
  rotation, and ownership-change audiences are tested end to end.
- `BuilderStateWire` remains the row-query transport shape where an accepted
  analytics operation needs it; normalized strict `BuilderState` owns
  planning and execution. See
  [ADR-0010](./0010-consumer-row-query-uses-builderstate.md).
- Webhook producers and realtime outbox producers stay in gscdump.com; SDK
  helpers remain consumer-side.

The normative implementation contract is
[`../hosted-api-v1.md`](../hosted-api-v1.md). This amendment supersedes only
the hosted route/realtime/consumer ownership portions of the original ADR; its
partner-versus-analytics separation and host-versus-package boundary remain.
