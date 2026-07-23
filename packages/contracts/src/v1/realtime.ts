import { z } from 'zod'
import { GSCDUMP_HTTP_V1_VERSION } from './version'

export const GSCDUMP_REALTIME_PROTOCOL_VERSION = 1 as const
export const GSCDUMP_REALTIME_SUBPROTOCOL = 'gscdump.v1' as const
export const GSCDUMP_REALTIME_TICKET_PREFIX = 'gscdump.ticket.v1' as const
export const GSCDUMP_REALTIME_TICKET_ISSUER = 'https://gscdump.com' as const
export const GSCDUMP_REALTIME_TICKET_AUDIENCE = 'https://gscdump.com/ws/v1' as const
export const GSCDUMP_REALTIME_PING = 'ping' as const
export const GSCDUMP_REALTIME_PONG = 'pong' as const
export const GSCDUMP_REALTIME_TICKET_TTL_SECONDS = 60 as const
export const GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS = 900 as const

export const GSCDUMP_REALTIME_TICKET_POLICY = {
  algorithm: 'HMAC-SHA-256',
  minimumSigningKeyBytes: 32,
  jtiRandomBits: 128,
  maxVerificationKeys: 2,
  futureIssuedAtToleranceMs: 5_000,
  expiryToleranceMs: 0,
  rotationOverlapMs: 90_000,
  maxBytes: 2_048,
  singleUse: true,
} as const

export const GSCDUMP_REALTIME_CONNECTION_POLICY = {
  helloDeadlineMs: 10_000,
  maxLifetimeMs: 900_000,
  connectionRefreshBeforeExpiryMs: 30_000,
  heartbeatIntervalMs: 25_000,
  staleAfterMs: 75_000,
  reconnectBaseDelayMs: 1_000,
  reconnectMaxDelayMs: 30_000,
  reconnectJitter: 'equal',
} as const

export const GSCDUMP_REALTIME_REPLAY_POLICY = {
  maxAgeMs: 86_400_000,
  maxEventsPerStream: 10_000,
} as const

export const GSCDUMP_REALTIME_LIMITS = {
  clientFrameMaxBytes: 16_384,
  durableEventMaxBytes: 65_536,
  ephemeralEventMaxBytes: 16_384,
  outboundFrameMaxBytes: 262_144,
  batchMaxEvents: 20,
  batchMaxBytes: 262_144,
  connectionAttachmentMaxBytes: 2_048,
} as const

export const GSCDUMP_REALTIME_ACK_POLICY = {
  softLagEvents: 100,
  softLagBytes: 1_048_576,
  hardLagEvents: 500,
  hardLagBytes: 4_194_304,
  hardLagCloseCode: 1013,
  effectRetryBeforeUnsafeResync: 3,
} as const

export const GSCDUMP_REALTIME_CLOSE_CODES = {
  normal: 1000,
  protocolError: 1002,
  policyViolation: 1008,
  internalError: 1011,
  serviceRestart: 1012,
  overloadedOrAckLag: 1013,
  maximumLifetime: 4001,
} as const

export const REALTIME_V1_RESOURCE_TYPES = [
  'partner.user',
  'partner.team',
  'user.sites',
  'site.registration',
  'site.lifecycle',
  'site.analytics',
  'site.sitemaps',
  'site.indexing',
  'site.auth',
] as const

export const REALTIME_V1_EVENT_NAMES = [
  'user.lifecycle.changed',
  'site.lifecycle.changed',
  'site.lifecycle.progress',
  'site.analytics.ready',
  'site.sitemaps.ready',
  'site.indexing.ready',
  'site.auth.failed',
  'site.lifecycle.failed',
  'site.registration.changed',
] as const

export const REALTIME_V1_EVENT_SEMANTICS = {
  'user.lifecycle.changed': { delivery: 'durable', baseChanges: ['partner.user', 'user.sites'] },
  'site.lifecycle.changed': { delivery: 'durable', baseChanges: ['site.lifecycle'] },
  'site.lifecycle.progress': { delivery: 'ephemeral', baseChanges: [] },
  'site.analytics.ready': { delivery: 'durable', baseChanges: ['site.analytics', 'site.lifecycle'] },
  'site.sitemaps.ready': { delivery: 'durable', baseChanges: ['site.sitemaps', 'site.lifecycle'] },
  'site.indexing.ready': { delivery: 'durable', baseChanges: ['site.indexing', 'site.lifecycle'] },
  'site.auth.failed': { delivery: 'durable', baseChanges: ['site.auth', 'site.lifecycle'] },
  'site.lifecycle.failed': { delivery: 'durable', baseChanges: ['site.lifecycle'] },
  'site.registration.changed': { delivery: 'durable', baseChanges: ['site.registration', 'user.sites'] },
} as const satisfies Record<
  typeof REALTIME_V1_EVENT_NAMES[number],
  {
    delivery: 'durable' | 'ephemeral'
    baseChanges: readonly typeof REALTIME_V1_RESOURCE_TYPES[number][]
  }
>

// The exact inferred return preserves schema-derived DTO types for consumers.
// eslint-disable-next-line ts/explicit-function-return-type
export function createRealtimeV1Schemas() {
  const sequence = z.string().regex(/^(0|[1-9]\d*)$/)
  const opaquePublicId = z.string().regex(/^[\w-]+$/)
  const publicUserId = z.string().regex(/^u_[\w-]+$/)
  const publicPartnerId = z.string().regex(/^p_[\w-]+$/)
  const publicTeamId = z.string().regex(/^t_[\w-]+$/)
  const publicSiteId = z.string().regex(/^s_[\w-]+$/)
  const publicPrincipalId = z.union([publicUserId, publicPartnerId])
  const publicResourceId = z.union([publicUserId, publicPartnerId, publicTeamId, publicSiteId])
  const publicRequestId = z.string().regex(/^req_[\w-]+$/)
  const publicEventId = z.string().regex(/^evt_[\w-]+$/)
  const userStreamId = z.string().regex(/^user:u_[\w-]+$/)
  const partnerStreamId = z.string().regex(/^partner:p_[\w-]+$/)
  const streamId = z.union([userStreamId, partnerStreamId])
  const origin = z.url().refine((value) => {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === value
  }, 'origin must be an exact HTTP(S) origin without a path, query, or fragment.')
  const cursor = z.strictObject({
    streamId,
    sequence,
  })
  const streamHead = z.strictObject({
    streamId,
    sequence,
  })
  const ticketResponseClient = z.looseObject({
    data: z.looseObject({
      socketUrl: z.url().refine(value => value.startsWith('wss://'), 'socketUrl must use wss.'),
      protocol: z.literal(GSCDUMP_REALTIME_SUBPROTOCOL),
      protocolVersion: z.literal(GSCDUMP_REALTIME_PROTOCOL_VERSION),
      ticket: z.string().max(GSCDUMP_REALTIME_TICKET_POLICY.maxBytes).regex(/^gscdump\.ticket\.v1\.[\w-]+\.[\w-]+$/),
      expiresAt: z.iso.datetime(),
      head: z.looseObject({
        streamId,
        sequence,
      }),
      maxConnectionSeconds: z.literal(GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS),
    }),
    meta: z.looseObject({
      requestId: publicRequestId,
      surface: z.literal('realtime'),
      version: z.literal(GSCDUMP_HTTP_V1_VERSION),
    }),
  })

  const ticketRequest = z.strictObject({
    origin: origin.optional(),
  })
  const ticketClaims = z.strictObject({
    v: z.literal(GSCDUMP_REALTIME_PROTOCOL_VERSION),
    iss: z.literal(GSCDUMP_REALTIME_TICKET_ISSUER),
    aud: z.literal(GSCDUMP_REALTIME_TICKET_AUDIENCE),
    kid: z.string().regex(/^[\w-]{1,128}$/),
    jti: z.string().regex(/^[\w-]{22,}$/),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    connectionExpiresAt: z.number().int().positive(),
    principalClass: z.enum(['user_key', 'partner_key']),
    principalPublicId: publicPrincipalId,
    streamId,
    origin: origin.nullable(),
  }).superRefine((claims, context) => {
    if (claims.exp <= claims.iat || claims.exp - claims.iat > GSCDUMP_REALTIME_TICKET_TTL_SECONDS) {
      context.addIssue({
        code: 'custom',
        message: `exp must be after iat and no more than ${GSCDUMP_REALTIME_TICKET_TTL_SECONDS} seconds later.`,
        path: ['exp'],
      })
    }
    if (claims.connectionExpiresAt <= claims.iat
      || claims.connectionExpiresAt - claims.iat > GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS) {
      context.addIssue({
        code: 'custom',
        message: `connectionExpiresAt must be after iat and no more than ${GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS} seconds later.`,
        path: ['connectionExpiresAt'],
      })
    }
    if (claims.connectionExpiresAt < claims.exp) {
      context.addIssue({
        code: 'custom',
        message: 'connectionExpiresAt cannot be earlier than exp.',
        path: ['connectionExpiresAt'],
      })
    }
    const expectedStream = claims.principalClass === 'user_key'
      ? `user:${claims.principalPublicId}`
      : `partner:${claims.principalPublicId}`
    if (claims.streamId !== expectedStream) {
      context.addIssue({
        code: 'custom',
        message: 'streamId must be the exact stream inferred from principalClass and principalPublicId.',
        path: ['streamId'],
      })
    }
    if (claims.principalClass === 'user_key' && !claims.principalPublicId.startsWith('u_')) {
      context.addIssue({ code: 'custom', message: 'A user principal requires a user public ID.', path: ['principalPublicId'] })
    }
    if (claims.principalClass === 'partner_key' && !claims.principalPublicId.startsWith('p_')) {
      context.addIssue({ code: 'custom', message: 'A partner principal requires a partner public ID.', path: ['principalPublicId'] })
    }
  })

  const knownResourceType = z.enum(REALTIME_V1_RESOURCE_TYPES)
  const resourceChange = z.strictObject({
    // Unknown resource names are intentionally parseable. Older clients use
    // the subject-level purge rule instead of treating them as harmless.
    type: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/),
    id: opaquePublicId,
    kind: z.enum(['created', 'updated', 'deleted']),
  }).superRefine((change, context) => {
    const prefix = change.type === 'partner.user' || change.type === 'user.sites'
      ? 'u_'
      : change.type === 'partner.team'
        ? 't_'
        : REALTIME_V1_RESOURCE_TYPES.includes(change.type as typeof REALTIME_V1_RESOURCE_TYPES[number])
          && change.type.startsWith('site.')
          ? 's_'
          : null
    if (prefix && !change.id.startsWith(prefix)) {
      context.addIssue({
        code: 'custom',
        message: `${change.type} requires an opaque ${prefix} public ID.`,
        path: ['id'],
      })
    }
  })
  const subject = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('partner'), id: publicPartnerId }),
    z.strictObject({ type: z.literal('team'), id: publicTeamId }),
    z.strictObject({ type: z.literal('user'), id: publicUserId }),
    z.strictObject({ type: z.literal('site'), id: publicSiteId }),
  ])
  const eventBase = {
    type: z.literal('event'),
    protocolVersion: z.literal(GSCDUMP_REALTIME_PROTOCOL_VERSION),
    eventVersion: z.number().int().positive(),
    id: publicEventId,
    // Unknown event names are compatible because base changes remain usable.
    name: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/),
    subject,
    changes: z.array(resourceChange),
    occurredAt: z.iso.datetime(),
    correlationId: publicRequestId.nullable(),
    data: z.json(),
  }
  const durableEvent = z.strictObject({
    ...eventBase,
    cursor,
    changes: z.array(resourceChange).min(1),
    delivery: z.literal('durable'),
  }).superRefine((event, context) => {
    const semantics = REALTIME_V1_EVENT_SEMANTICS[event.name as keyof typeof REALTIME_V1_EVENT_SEMANTICS]
    if (semantics?.delivery === 'ephemeral') {
      context.addIssue({
        code: 'custom',
        message: `${event.name} must use ephemeral delivery.`,
        path: ['delivery'],
      })
    }
    if (semantics) {
      for (const requiredType of semantics.baseChanges) {
        if (!event.changes.some(change => change.type === requiredType)) {
          context.addIssue({
            code: 'custom',
            message: `${event.name} requires a ${requiredType} base change.`,
            path: ['changes'],
          })
        }
      }
    }
  })
  const ephemeralEvent = z.strictObject({
    ...eventBase,
    cursor: z.null(),
    changes: z.array(resourceChange).max(0),
    delivery: z.literal('ephemeral'),
  }).superRefine((event, context) => {
    const semantics = REALTIME_V1_EVENT_SEMANTICS[event.name as keyof typeof REALTIME_V1_EVENT_SEMANTICS]
    if (semantics?.delivery === 'durable') {
      context.addIssue({
        code: 'custom',
        message: `${event.name} must use durable delivery.`,
        path: ['delivery'],
      })
    }
  })
  const event = z.union([durableEvent, ephemeralEvent])

  const helloFrame = z.strictObject({
    type: z.literal('hello'),
    protocolVersion: z.literal(GSCDUMP_REALTIME_PROTOCOL_VERSION),
    sdkVersion: z.string().min(1),
    resume: cursor.nullable(),
  })
  const ackFrame = z.strictObject({
    type: z.literal('ack'),
    cursor,
  })
  const readyFrame = z.strictObject({
    type: z.literal('ready'),
    protocolVersion: z.literal(GSCDUMP_REALTIME_PROTOCOL_VERSION),
    connectionId: z.string().regex(/^conn_[\w-]+$/),
    streamId,
    replayFloor: streamHead,
    head: streamHead,
    limits: z.strictObject({
      maxBatchEvents: z.number().int().positive().max(GSCDUMP_REALTIME_LIMITS.batchMaxEvents),
      maxUnackedEvents: z.number().int().positive().max(GSCDUMP_REALTIME_ACK_POLICY.hardLagEvents),
    }),
    heartbeat: z.strictObject({
      ping: z.literal(GSCDUMP_REALTIME_PING),
      pong: z.literal(GSCDUMP_REALTIME_PONG),
    }),
    expiresAt: z.iso.datetime(),
  }).superRefine((frame, context) => {
    if (frame.head.streamId !== frame.streamId || frame.replayFloor.streamId !== frame.streamId) {
      context.addIssue({ code: 'custom', message: 'ready head and replayFloor must match streamId.' })
    }
    if (BigInt(frame.replayFloor.sequence) > BigInt(frame.head.sequence)) {
      context.addIssue({ code: 'custom', message: 'replayFloor cannot be ahead of head.', path: ['replayFloor'] })
    }
  })
  const replayBeginFrame = z.strictObject({
    type: z.literal('replay.begin'),
    after: cursor.nullable(),
    through: cursor,
  }).superRefine((frame, context) => {
    if (!frame.after)
      return
    if (frame.after.streamId !== frame.through.streamId) {
      context.addIssue({ code: 'custom', message: 'Replay cursors must belong to one stream.', path: ['through'] })
    }
    if (BigInt(frame.after.sequence) > BigInt(frame.through.sequence)) {
      context.addIssue({ code: 'custom', message: 'Replay through cannot be behind after.', path: ['through'] })
    }
  })
  const replayEndFrame = z.strictObject({
    type: z.literal('replay.end'),
    through: cursor,
  })
  const batchFrame = z.strictObject({
    type: z.literal('batch'),
    events: z.array(durableEvent).min(1).max(GSCDUMP_REALTIME_LIMITS.batchMaxEvents),
  }).superRefine((frame, context) => {
    const first = frame.events[0]
    if (!first)
      return
    for (const [index, current] of frame.events.entries()) {
      if (current.cursor.streamId !== first.cursor.streamId) {
        context.addIssue({
          code: 'custom',
          message: 'A batch must contain events from one exact stream.',
          path: ['events', index, 'cursor', 'streamId'],
        })
      }
      const previous = frame.events[index - 1]
      if (previous && BigInt(current.cursor.sequence) !== BigInt(previous.cursor.sequence) + 1n) {
        context.addIssue({
          code: 'custom',
          message: 'Batch cursors must be contiguous and ordered.',
          path: ['events', index, 'cursor', 'sequence'],
        })
      }
    }
  })
  const resyncRequiredFrame = z.strictObject({
    type: z.literal('resync.required'),
    reason: z.enum(['cursor_expired', 'retention_gap', 'sequence_gap', 'stream_mismatch']),
    scope: z.strictObject({
      type: z.literal('stream'),
      streamId,
    }),
    resumeAfter: cursor,
  }).superRefine((frame, context) => {
    if (frame.scope.streamId !== frame.resumeAfter.streamId) {
      context.addIssue({
        code: 'custom',
        message: 'resync.required scope and resumeAfter must identify one exact stream.',
        path: ['resumeAfter', 'streamId'],
      })
    }
  })
  const realtimeErrorFrame = z.strictObject({
    type: z.literal('error'),
    error: z.strictObject({
      code: z.enum(['invalid_frame', 'protocol_mismatch', 'policy_violation', 'overloaded', 'internal_error']),
      message: z.string().min(1),
      retryable: z.boolean(),
      retryAfter: z.number().int().nonnegative().optional(),
    }),
  })

  return {
    opaquePublicId,
    userStreamId,
    partnerStreamId,
    publicUserId,
    publicPartnerId,
    publicTeamId,
    publicSiteId,
    publicPrincipalId,
    publicResourceId,
    publicRequestId,
    publicEventId,
    sequence,
    streamId,
    cursor,
    streamHead,
    ticketResponseClient,
    ticketRequest,
    ticketClaims,
    knownResourceType,
    resourceChange,
    subject,
    durableEvent,
    ephemeralEvent,
    event,
    helloFrame,
    ackFrame,
    readyFrame,
    replayBeginFrame,
    replayEndFrame,
    batchFrame,
    resyncRequiredFrame,
    realtimeErrorFrame,
    clientFrame: z.union([helloFrame, ackFrame]),
    serverFrame: z.union([
      readyFrame,
      replayBeginFrame,
      replayEndFrame,
      event,
      batchFrame,
      resyncRequiredFrame,
      realtimeErrorFrame,
    ]),
  }
}

export type RealtimeV1Schemas = ReturnType<typeof createRealtimeV1Schemas>
export type RealtimeV1StreamId = z.infer<RealtimeV1Schemas['streamId']>
export type RealtimeV1Cursor = z.infer<RealtimeV1Schemas['cursor']>
export type RealtimeV1StreamHead = z.infer<RealtimeV1Schemas['streamHead']>
export type RealtimeTicketV1Response = z.infer<RealtimeV1Schemas['ticketResponseClient']>
export type RealtimeV1TicketRequest = z.infer<RealtimeV1Schemas['ticketRequest']>
export type RealtimeV1TicketClaims = z.infer<RealtimeV1Schemas['ticketClaims']>
export type RealtimeV1ResourceChange = z.infer<RealtimeV1Schemas['resourceChange']>
export type RealtimeV1Event = z.infer<RealtimeV1Schemas['event']>
export type RealtimeV1ClientFrame = z.infer<RealtimeV1Schemas['clientFrame']>
export type RealtimeV1ServerFrame = z.infer<RealtimeV1Schemas['serverFrame']>
