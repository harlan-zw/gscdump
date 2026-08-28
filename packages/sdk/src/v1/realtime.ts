import type {
  RealtimeTicketV1Response,
  RealtimeV1Cursor,
  RealtimeV1Event,
  RealtimeV1ServerFrame,
  RealtimeV1StreamHead,
  RealtimeV1StreamId,
} from '@gscdump/contracts/v1/realtime'
import {
  createRealtimeV1Schemas,
  GSCDUMP_REALTIME_ACK_POLICY,
  GSCDUMP_REALTIME_CLOSE_CODES,
  GSCDUMP_REALTIME_CONNECTION_POLICY,
  GSCDUMP_REALTIME_LIMITS,
  GSCDUMP_REALTIME_PING,
  GSCDUMP_REALTIME_PONG,
  GSCDUMP_REALTIME_PROTOCOL_VERSION,
  GSCDUMP_REALTIME_SUBPROTOCOL,
  REALTIME_V1_EVENT_NAMES,
  REALTIME_V1_RESOURCE_TYPES,
} from '@gscdump/contracts/v1/realtime'
import { utf8Size } from '../utf8'

type MaybePromise<T> = T | Promise<T>
type RealtimeTicketData = RealtimeTicketV1Response['data']

export const GSCDUMP_REALTIME_V1_SDK_VERSION = '3.4.0' as const

export type GscdumpRealtimeV1TransportState
  = | 'idle'
    | 'ticketing'
    | 'connecting'
    | 'handshaking'
    | 'replaying'
    | 'live'
    | 'waiting'
    | 'stopped'
    | 'terminal'

export type GscdumpRealtimeV1Freshness
  = | 'unknown'
    | 'stale'
    | 'applying'
    | 'fresh'
    | 'resyncing'
    | 'degraded'

export type GscdumpRealtimeV1ErrorCode
  = | 'cursor_store_failed'
    | 'effect_failed'
    | 'heartbeat_stale'
    | 'integration_failed'
    | 'protocol_error'
    | 'resync_failed'
    | 'runtime_unavailable'
    | 'socket_error'
    | 'ticket_invalid'
    | 'ticket_provider_failed'
    | 'upgrade_rejected'

export interface GscdumpRealtimeV1ErrorOptions {
  code: GscdumpRealtimeV1ErrorCode
  message: string
  retryable: boolean
  terminal: boolean
  details?: Record<string, unknown>
  cause?: unknown
}

export class GscdumpRealtimeV1Error extends Error {
  readonly tag = 'GscdumpRealtimeV1Error' as const
  readonly code: GscdumpRealtimeV1ErrorCode
  readonly retryable: boolean
  readonly terminal: boolean
  readonly details: Record<string, unknown>
  override readonly cause?: unknown

  constructor(options: GscdumpRealtimeV1ErrorOptions) {
    super(options.message)
    this.name = 'GscdumpRealtimeV1Error'
    this.code = options.code
    this.retryable = options.retryable
    this.terminal = options.terminal
    this.details = options.details ?? {}
    this.cause = options.cause
  }
}

export interface GscdumpRealtimeV1CursorStore {
  load: () => MaybePromise<RealtimeV1Cursor | null>
  save: (cursor: RealtimeV1Cursor) => MaybePromise<void>
}

export interface GscdumpRealtimeV1SocketLike {
  readonly readyState: number
  readonly protocol: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code?: number, reason?: string, wasClean?: boolean }) => void) | null
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

export interface GscdumpRealtimeV1Runtime {
  createSocket: (url: string, protocols: readonly string[]) => GscdumpRealtimeV1SocketLike
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  random: () => number
  now: () => number
}

export type GscdumpRealtimeV1ResyncReason
  = 'cursor_expired'
    | 'retention_gap'
    | 'sequence_gap'
    | 'stream_mismatch'
    | 'initial_cursor_missing'
    | 'effect_application_failed'

export interface GscdumpRealtimeV1ResyncRequest {
  reason: GscdumpRealtimeV1ResyncReason
  source: 'server' | 'client'
  streamId: RealtimeV1StreamId
  previousCursor: RealtimeV1Cursor | null
  resumeAfter: RealtimeV1Cursor
  failedEvent?: RealtimeV1Event
  cause?: unknown
}

export interface GscdumpRealtimeV1Snapshot {
  transport: GscdumpRealtimeV1TransportState
  freshness: GscdumpRealtimeV1Freshness
  attempt: number
  streamId: RealtimeV1StreamId | null
  cursor: RealtimeV1Cursor | null
  head: RealtimeV1StreamHead | null
  error: GscdumpRealtimeV1Error | null
}

export type GscdumpRealtimeV1Observation
  = { type: 'state', state: GscdumpRealtimeV1Snapshot }
    | { type: 'event', event: RealtimeV1Event, cursor: RealtimeV1Cursor | null }
    | { type: 'error', error: GscdumpRealtimeV1Error, state: GscdumpRealtimeV1Snapshot }
    | { type: 'advisory', code: 'unknown_event' | 'unknown_resource' | 'unsupported_event_version', event: RealtimeV1Event }

export interface CreateGscdumpRealtimeV1ClientOptions {
  /** Called for every connection attempt. A ticket is never reused. */
  ticketProvider: () => MaybePromise<unknown>
  /** Required correctness effect for each contiguous durable event. */
  applyEvent: (event: RealtimeV1Event) => Promise<void>
  /** Required full authoritative reseed used whenever replay is unsafe. */
  resync: (request: GscdumpRealtimeV1ResyncRequest) => Promise<void>
  cursorStore?: GscdumpRealtimeV1CursorStore
  /** One isolated callback for state, event, advisory, and error observations. */
  onObservation?: (observation: GscdumpRealtimeV1Observation) => unknown
  runtime?: GscdumpRealtimeV1Runtime
  sdkVersion?: string
}

export interface GscdumpRealtimeV1Client {
  start: () => Promise<void>
  stop: () => void
  getSnapshot: () => GscdumpRealtimeV1Snapshot
}

interface ConnectionContext {
  epoch: number
  socket: GscdumpRealtimeV1SocketLike
  ticket: RealtimeTicketData
  accepted: boolean
  ready: boolean
  closed: boolean
  replaying: boolean
  replayThrough: RealtimeV1Cursor | null
  lastPongAt: number
  head: RealtimeV1StreamHead | null
  retryAfterMs: number | undefined
  frameQueue: Promise<void>
}

class StaleEpochError extends Error {
  constructor() {
    super('The realtime connection epoch is no longer active.')
    this.name = 'StaleEpochError'
  }
}

function createMemoryCursorStore(): GscdumpRealtimeV1CursorStore {
  let value: RealtimeV1Cursor | null = null
  return {
    load: () => value,
    save: (cursor) => {
      value = { ...cursor }
    },
  }
}

function defaultRuntime(): GscdumpRealtimeV1Runtime {
  return {
    createSocket(url, protocols) {
      if (typeof globalThis.WebSocket !== 'function') {
        throw new GscdumpRealtimeV1Error({
          code: 'runtime_unavailable',
          message: 'This runtime does not provide WebSocket; inject a realtime runtime port.',
          retryable: false,
          terminal: true,
        })
      }
      return new globalThis.WebSocket(url, [...protocols]) as unknown as GscdumpRealtimeV1SocketLike
    },
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
    now: () => Date.now(),
  }
}

const UTF8_DECODER = new TextDecoder()
const REALTIME_EVENT_NAMES = new Set<string>(REALTIME_V1_EVENT_NAMES)
const REALTIME_RESOURCE_TYPES = new Set<string>(REALTIME_V1_RESOURCE_TYPES)
const APPLIED_EVENT_CACHE_MAX = 10_000

async function messageText(raw: unknown): Promise<string> {
  if (typeof raw === 'string')
    return raw
  if (raw instanceof ArrayBuffer)
    return UTF8_DECODER.decode(raw)
  if (ArrayBuffer.isView(raw))
    return UTF8_DECODER.decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
  if (typeof Blob !== 'undefined' && raw instanceof Blob)
    return raw.text()
  throw new TypeError('Realtime frames must be text or UTF-8 binary data.')
}

function compareSequence(left: string, right: string): -1 | 0 | 1 {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function nextSequence(sequence: string): string {
  return (BigInt(sequence) + 1n).toString()
}

function laterCursor(left: RealtimeV1Cursor, right: RealtimeV1Cursor): RealtimeV1Cursor {
  return compareSequence(left.sequence, right.sequence) >= 0 ? left : right
}

function sameCursor(left: RealtimeV1Cursor | null, right: RealtimeV1Cursor | null): boolean {
  return left?.streamId === right?.streamId && left?.sequence === right?.sequence
}

function parseErrorDetails(cause: unknown): Record<string, unknown> {
  if (typeof cause === 'object' && cause !== null && 'issues' in cause)
    return { issues: (cause as { issues: unknown }).issues }
  return {}
}

function safeRandom(random: () => number): number {
  const value = random()
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
}

/**
 * Own the v1 cursor/ACK correctness state machine. Framework adapters provide
 * required effects; they never need to reproduce transport ordering rules.
 */
export function createGscdumpRealtimeV1Client(
  options: CreateGscdumpRealtimeV1ClientOptions,
): GscdumpRealtimeV1Client {
  const schemas = createRealtimeV1Schemas()
  const runtime = options.runtime ?? defaultRuntime()
  const cursorStore = options.cursorStore ?? createMemoryCursorStore()
  const sdkVersion = options.sdkVersion ?? GSCDUMP_REALTIME_V1_SDK_VERSION

  if (!sdkVersion)
    throw new TypeError('sdkVersion cannot be empty.')

  let running = false
  let epoch = 0
  let reconnectTimer: unknown
  let heartbeatTimer: unknown
  let rotationTimer: unknown
  let current: ConnectionContext | null = null
  let immediateExpiredTicketRetry = true
  let cursor: RealtimeV1Cursor | null = null
  let streamId: RealtimeV1StreamId | null = null
  let head: RealtimeV1StreamHead | null = null
  let attempt = 0
  let transport: GscdumpRealtimeV1TransportState = 'idle'
  let freshness: GscdumpRealtimeV1Freshness = 'unknown'
  let lastError: GscdumpRealtimeV1Error | null = null
  const eventFailures = new Map<string, number>()
  const appliedEventIds = new Set<string>()
  const appliedEventOrder: string[] = []
  let appliedEventCursor = 0

  function getSnapshot(): GscdumpRealtimeV1Snapshot {
    return {
      transport,
      freshness,
      attempt,
      streamId,
      cursor: cursor ? { ...cursor } : null,
      head: head ? { ...head } : null,
      error: lastError,
    }
  }

  function observe(observation: GscdumpRealtimeV1Observation): void {
    if (!options.onObservation)
      return
    try {
      Promise.resolve(options.onObservation(observation)).catch(() => {})
    }
    catch {
      // Observers sit after the correctness boundary and cannot change it.
    }
  }

  function emitState(): void {
    observe({ type: 'state', state: getSnapshot() })
  }

  function setState(
    nextTransport: GscdumpRealtimeV1TransportState,
    nextFreshness: GscdumpRealtimeV1Freshness = freshness,
  ): void {
    transport = nextTransport
    freshness = nextFreshness
    emitState()
  }

  function reportError(error: GscdumpRealtimeV1Error): void {
    lastError = error
    observe({ type: 'error', error, state: getSnapshot() })
    emitState()
  }

  function clearTimer(handle: unknown): void {
    if (handle !== undefined)
      runtime.clearTimeout(handle)
  }

  function clearConnectionTimers(): void {
    clearTimer(heartbeatTimer)
    clearTimer(rotationTimer)
    heartbeatTimer = undefined
    rotationTimer = undefined
  }

  function ensureEpoch(context: ConnectionContext): void {
    if (!running || current !== context || context.closed || context.epoch !== epoch)
      throw new StaleEpochError()
  }

  function closeSocket(context: ConnectionContext, code: number, reason: string): void {
    if (context.closed)
      return
    context.closed = true
    if (current === context) {
      current = null
      epoch++
    }
    clearConnectionTimers()
    try {
      context.socket.close(code, reason)
    }
    catch {
      // Closing is best effort after the epoch has already been invalidated.
    }
  }

  function reconnectBackoff(): number {
    const exponent = Math.max(0, attempt - 1)
    const cap = Math.min(
      GSCDUMP_REALTIME_CONNECTION_POLICY.reconnectMaxDelayMs,
      GSCDUMP_REALTIME_CONNECTION_POLICY.reconnectBaseDelayMs * 2 ** exponent,
    )
    return cap / 2 + safeRandom(runtime.random) * cap / 2
  }

  function scheduleReconnect(
    context: ConnectionContext | null,
    reason: string,
    minimumDelayMs = 0,
    immediate = false,
  ): void {
    if (!running)
      return
    if (context)
      closeSocket(context, GSCDUMP_REALTIME_CLOSE_CODES.internalError, reason)
    clearTimer(reconnectTimer)
    attempt++
    const delay = immediate ? minimumDelayMs : Math.max(minimumDelayMs, reconnectBackoff())
    const disconnectedFreshness = freshness === 'unknown' || freshness === 'degraded'
      ? freshness
      : 'stale'
    setState('waiting', disconnectedFreshness)
    reconnectTimer = runtime.setTimeout(() => {
      reconnectTimer = undefined
      void beginAttempt()
    }, delay)
  }

  function terminal(
    error: GscdumpRealtimeV1Error,
    context: ConnectionContext | null = current,
  ): void {
    running = false
    clearTimer(reconnectTimer)
    reconnectTimer = undefined
    if (context)
      closeSocket(context, GSCDUMP_REALTIME_CLOSE_CODES.normal, 'terminal')
    freshness = 'degraded'
    transport = 'terminal'
    reportError(error)
  }

  function assertStream(value: { streamId: string }, context: ConnectionContext, label: string): void {
    if (value.streamId !== context.ticket.head.streamId) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: `${label} did not match the ticket's exact stream.`,
        retryable: false,
        terminal: true,
        details: { expected: context.ticket.head.streamId, received: value.streamId },
      })
    }
  }

  function sendJson(context: ConnectionContext, value: unknown): void {
    ensureEpoch(context)
    const serialized = JSON.stringify(value)
    if (utf8Size(serialized) > GSCDUMP_REALTIME_LIMITS.clientFrameMaxBytes) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: 'The generated client frame exceeded the v1 size limit.',
        retryable: false,
        terminal: true,
      })
    }
    try {
      context.socket.send(serialized)
    }
    catch (cause) {
      throw new GscdumpRealtimeV1Error({
        code: 'socket_error',
        message: 'Could not send a realtime client frame.',
        retryable: true,
        terminal: false,
        cause,
      })
    }
  }

  function sendAck(context: ConnectionContext, appliedCursor: RealtimeV1Cursor): void {
    const frame = schemas.ackFrame.parse({ type: 'ack', cursor: appliedCursor })
    sendJson(context, frame)
  }

  function eventDedupeKey(stream: RealtimeV1StreamId, id: string): string {
    return `${stream}:${id}`
  }

  function rememberEvent(stream: RealtimeV1StreamId, id: string): void {
    const key = eventDedupeKey(stream, id)
    if (appliedEventIds.has(key))
      return
    appliedEventIds.add(key)
    if (appliedEventOrder.length < APPLIED_EVENT_CACHE_MAX) {
      appliedEventOrder.push(key)
    }
    else {
      const oldest = appliedEventOrder[appliedEventCursor]
      if (oldest)
        appliedEventIds.delete(oldest)
      appliedEventOrder[appliedEventCursor] = key
      appliedEventCursor = (appliedEventCursor + 1) % APPLIED_EVENT_CACHE_MAX
    }
  }

  function eventFailureKey(event: RealtimeV1Event): string {
    return `${event.cursor?.streamId ?? 'ephemeral'}:${event.id}:${event.cursor?.sequence ?? 'ephemeral'}`
  }

  function eventForRequiredEffect(event: RealtimeV1Event): RealtimeV1Event {
    const knownEvent = REALTIME_EVENT_NAMES.has(event.name)
    return knownEvent && event.eventVersion === 1
      ? event
      : { ...event, data: null }
  }

  function eventAdvisories(event: RealtimeV1Event): void {
    if (!REALTIME_EVENT_NAMES.has(event.name))
      observe({ type: 'advisory', code: 'unknown_event', event })
    else if (event.eventVersion !== 1)
      observe({ type: 'advisory', code: 'unsupported_event_version', event })
    if (event.changes.some(change => !REALTIME_RESOURCE_TYPES.has(change.type)))
      observe({ type: 'advisory', code: 'unknown_resource', event })
  }

  async function saveCursor(
    context: ConnectionContext,
    nextCursor: RealtimeV1Cursor,
  ): Promise<void> {
    ensureEpoch(context)
    await cursorStore.save(nextCursor)
    ensureEpoch(context)
  }

  async function performResync(
    context: ConnectionContext,
    request: GscdumpRealtimeV1ResyncRequest,
  ): Promise<void> {
    ensureEpoch(context)
    setState('handshaking', 'resyncing')
    try {
      await options.resync(request)
      ensureEpoch(context)
    }
    catch (cause) {
      if (cause instanceof StaleEpochError || !running || current !== context || context.closed)
        return
      terminal(new GscdumpRealtimeV1Error({
        code: 'resync_failed',
        message: `Realtime resync failed (${request.reason}).`,
        retryable: false,
        terminal: true,
        details: { reason: request.reason, resumeAfter: request.resumeAfter },
        cause,
      }), context)
      return
    }

    try {
      await saveCursor(context, request.resumeAfter)
    }
    catch (cause) {
      if (cause instanceof StaleEpochError || !running || current !== context || context.closed)
        return
      terminal(new GscdumpRealtimeV1Error({
        code: 'cursor_store_failed',
        message: 'Realtime resync completed, but its resume cursor could not be persisted.',
        retryable: false,
        terminal: true,
        details: { resumeAfter: request.resumeAfter },
        cause,
      }), context)
      return
    }

    cursor = { ...request.resumeAfter }
    eventFailures.clear()
    emitState()
    scheduleReconnect(context, 'resync-complete', 0, true)
  }

  async function handleEventFailure(
    context: ConnectionContext,
    event: RealtimeV1Event,
    code: 'cursor_store_failed' | 'effect_failed',
    cause: unknown,
  ): Promise<void> {
    if (cause instanceof StaleEpochError)
      return
    ensureEpoch(context)
    const key = eventFailureKey(event)
    const failures = (eventFailures.get(key) ?? 0) + 1
    eventFailures.set(key, failures)
    const error = new GscdumpRealtimeV1Error({
      code,
      message: code === 'effect_failed'
        ? `The required effect rejected for durable event ${event.id}.`
        : `The cursor store rejected durable event ${event.id}.`,
      retryable: failures < GSCDUMP_REALTIME_ACK_POLICY.effectRetryBeforeUnsafeResync,
      terminal: false,
      details: { eventId: event.id, sequence: event.cursor?.sequence, failures },
      cause,
    })
    freshness = 'degraded'
    reportError(error)

    if (failures < GSCDUMP_REALTIME_ACK_POLICY.effectRetryBeforeUnsafeResync) {
      scheduleReconnect(context, code)
      return
    }

    const eventCursor = event.cursor
    if (!eventCursor)
      return
    const resumeAfter = context.head
      ? laterCursor(context.head, eventCursor)
      : eventCursor
    await performResync(context, {
      reason: 'effect_application_failed',
      source: 'client',
      streamId: eventCursor.streamId,
      previousCursor: cursor,
      resumeAfter,
      failedEvent: event,
      cause,
    })
  }

  async function applyDurableEvent(
    context: ConnectionContext,
    event: Extract<RealtimeV1Event, { delivery: 'durable' }>,
  ): Promise<void> {
    ensureEpoch(context)
    assertStream(event.cursor, context, 'event cursor')

    if (context.replayThrough
      && compareSequence(event.cursor.sequence, context.replayThrough.sequence) > 0) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: 'A live event arrived before the declared replay completed.',
        retryable: false,
        terminal: true,
      })
    }
    if (!context.replaying
      && (!context.head || compareSequence(event.cursor.sequence, context.head.sequence) > 0)) {
      context.head = { ...event.cursor }
      head = { ...event.cursor }
    }

    if (!cursor) {
      await performResync(context, {
        reason: 'initial_cursor_missing',
        source: 'client',
        streamId: event.cursor.streamId,
        previousCursor: null,
        resumeAfter: context.head ? laterCursor(context.head, event.cursor) : event.cursor,
      })
      return
    }
    assertStream(cursor, context, 'stored cursor')
    const order = compareSequence(event.cursor.sequence, cursor.sequence)
    if (order <= 0) {
      // At-least-once replay can resend an already durably applied event.
      sendAck(context, cursor)
      return
    }
    if (event.cursor.sequence !== nextSequence(cursor.sequence)) {
      const resumeAfter = context.head ? laterCursor(context.head, event.cursor) : event.cursor
      await performResync(context, {
        reason: 'sequence_gap',
        source: 'client',
        streamId: event.cursor.streamId,
        previousCursor: cursor,
        resumeAfter,
      })
      return
    }

    setState(context.replaying ? 'replaying' : 'live', 'applying')
    const effectEvent = eventForRequiredEffect(event)
    if (!appliedEventIds.has(eventDedupeKey(event.cursor.streamId, event.id))) {
      try {
        await options.applyEvent(effectEvent)
        ensureEpoch(context)
      }
      catch (cause) {
        await handleEventFailure(context, event, 'effect_failed', cause)
        return
      }
    }

    try {
      await saveCursor(context, event.cursor)
    }
    catch (cause) {
      await handleEventFailure(context, event, 'cursor_store_failed', cause)
      return
    }

    cursor = { ...event.cursor }
    rememberEvent(event.cursor.streamId, event.id)
    eventFailures.delete(eventFailureKey(event))
    sendAck(context, cursor)
    freshness = context.replaying ? 'stale' : 'fresh'
    transport = context.replaying ? 'replaying' : 'live'
    emitState()
    eventAdvisories(effectEvent)
    observe({ type: 'event', event: effectEvent, cursor: { ...cursor } })
  }

  function scheduleHeartbeat(context: ConnectionContext): void {
    clearTimer(heartbeatTimer)
    heartbeatTimer = runtime.setTimeout(() => {
      heartbeatTimer = undefined
      if (!running || current !== context || context.closed)
        return
      const staleFor = runtime.now() - context.lastPongAt
      if (staleFor >= GSCDUMP_REALTIME_CONNECTION_POLICY.staleAfterMs) {
        const error = new GscdumpRealtimeV1Error({
          code: 'heartbeat_stale',
          message: 'Realtime heartbeat became stale.',
          retryable: true,
          terminal: false,
          details: { staleFor },
        })
        freshness = 'stale'
        reportError(error)
        scheduleReconnect(context, 'heartbeat-stale')
        return
      }
      try {
        context.socket.send(GSCDUMP_REALTIME_PING)
      }
      catch (cause) {
        const error = new GscdumpRealtimeV1Error({
          code: 'socket_error',
          message: 'Could not send the realtime heartbeat.',
          retryable: true,
          terminal: false,
          cause,
        })
        reportError(error)
        scheduleReconnect(context, 'heartbeat-send')
        return
      }
      scheduleHeartbeat(context)
    }, GSCDUMP_REALTIME_CONNECTION_POLICY.heartbeatIntervalMs)
  }

  function scheduleRotation(context: ConnectionContext, expiresAt: string): void {
    clearTimer(rotationTimer)
    const expiry = Date.parse(expiresAt)
    const delay = Math.max(
      0,
      expiry - runtime.now() - GSCDUMP_REALTIME_CONNECTION_POLICY.connectionRefreshBeforeExpiryMs,
    )
    rotationTimer = runtime.setTimeout(() => {
      rotationTimer = undefined
      if (running && current === context && !context.closed)
        scheduleReconnect(context, 'connection-expiry-rotation', 0, true)
    }, delay)
  }

  async function handleReady(
    context: ConnectionContext,
    frame: Extract<RealtimeV1ServerFrame, { type: 'ready' }>,
  ): Promise<void> {
    ensureEpoch(context)
    if (context.ready) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: 'The server sent more than one ready frame.',
        retryable: false,
        terminal: true,
      })
    }
    assertStream(frame, context, 'ready frame')
    assertStream(frame.head, context, 'ready head')
    assertStream(frame.replayFloor, context, 'ready replay floor')
    if (compareSequence(frame.head.sequence, context.ticket.head.sequence) < 0) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: 'The ready head regressed behind the ticket head.',
        retryable: false,
        terminal: true,
        details: { ticketHead: context.ticket.head, readyHead: frame.head },
      })
    }
    const expiresAt = Date.parse(frame.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= runtime.now()
      || expiresAt - runtime.now() > context.ticket.maxConnectionSeconds * 1_000) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: 'The ready frame carried an invalid signed connection expiry.',
        retryable: false,
        terminal: true,
        details: { expiresAt: frame.expiresAt },
      })
    }

    context.ready = true
    context.head = { ...frame.head }
    context.lastPongAt = runtime.now()
    head = { ...frame.head }
    streamId = frame.streamId
    attempt = 0
    lastError = null
    scheduleHeartbeat(context)
    scheduleRotation(context, frame.expiresAt)

    if (!cursor) {
      await performResync(context, {
        reason: 'initial_cursor_missing',
        source: 'client',
        streamId: frame.streamId,
        previousCursor: null,
        resumeAfter: frame.head,
      })
      return
    }
    if (cursor.streamId !== frame.streamId) {
      await performResync(context, {
        reason: 'stream_mismatch',
        source: 'client',
        streamId: frame.streamId,
        previousCursor: cursor,
        resumeAfter: frame.head,
      })
      return
    }
    if (compareSequence(cursor.sequence, frame.head.sequence) > 0) {
      await performResync(context, {
        reason: 'sequence_gap',
        source: 'client',
        streamId: frame.streamId,
        previousCursor: cursor,
        resumeAfter: frame.head,
      })
      return
    }
    if (compareSequence(cursor.sequence, frame.replayFloor.sequence) < 0) {
      await performResync(context, {
        reason: 'cursor_expired',
        source: 'client',
        streamId: frame.streamId,
        previousCursor: cursor,
        resumeAfter: frame.head,
      })
      return
    }
    if (sameCursor(cursor, frame.head)) {
      context.replaying = false
      setState('live', 'fresh')
    }
    else {
      context.replaying = true
      setState('replaying', 'stale')
    }
  }

  async function processFrame(context: ConnectionContext, frame: RealtimeV1ServerFrame): Promise<void> {
    ensureEpoch(context)
    if (frame.type === 'ready') {
      await handleReady(context, frame)
      return
    }
    if (frame.type === 'error') {
      const terminalServerCode = frame.error.code === 'invalid_frame'
        || frame.error.code === 'protocol_mismatch'
        || frame.error.code === 'policy_violation'
      const retryable = !terminalServerCode && frame.error.retryable
      const error = new GscdumpRealtimeV1Error({
        code: frame.error.code === 'internal_error' || frame.error.code === 'overloaded'
          ? 'socket_error'
          : 'protocol_error',
        message: frame.error.message,
        retryable,
        terminal: !retryable,
        details: { serverCode: frame.error.code, retryAfter: frame.error.retryAfter },
      })
      reportError(error)
      if (retryable) {
        context.retryAfterMs = frame.error.retryAfter === undefined ? undefined : frame.error.retryAfter * 1_000
        scheduleReconnect(context, 'server-error', context.retryAfterMs)
      }
      else {
        terminal(error, context)
      }
      return
    }
    if (!context.ready) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: `The server sent ${frame.type} before ready.`,
        retryable: false,
        terminal: true,
      })
    }

    if (frame.type === 'replay.begin') {
      assertStream(frame.through, context, 'replay through cursor')
      if (frame.after)
        assertStream(frame.after, context, 'replay after cursor')
      if (context.replayThrough) {
        throw new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: 'The server sent a nested replay.begin frame.',
          retryable: false,
          terminal: true,
        })
      }
      if (!sameCursor(frame.after, cursor)) {
        await performResync(context, {
          reason: 'sequence_gap',
          source: 'client',
          streamId: context.ticket.head.streamId,
          previousCursor: cursor,
          resumeAfter: frame.through,
        })
        return
      }
      if (!context.head || !sameCursor(frame.through, context.head)) {
        throw new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: 'The replay boundary did not match the ready head.',
          retryable: false,
          terminal: true,
        })
      }
      context.replaying = true
      context.replayThrough = { ...frame.through }
      setState('replaying', 'stale')
      return
    }

    if (frame.type === 'replay.end') {
      assertStream(frame.through, context, 'replay end cursor')
      if (!context.replaying
        || !context.replayThrough
        || !sameCursor(context.replayThrough, frame.through)
        || !sameCursor(cursor, frame.through)) {
        await performResync(context, {
          reason: 'sequence_gap',
          source: 'client',
          streamId: frame.through.streamId,
          previousCursor: cursor,
          resumeAfter: context.head ? laterCursor(context.head, frame.through) : frame.through,
        })
        return
      }
      context.replaying = false
      context.replayThrough = null
      setState('live', 'fresh')
      return
    }

    if (frame.type === 'resync.required') {
      assertStream(frame.scope, context, 'resync scope')
      assertStream(frame.resumeAfter, context, 'resync cursor')
      const minimumSequence = context.head && cursor
        ? laterCursor(context.head, cursor).sequence
        : context.head?.sequence ?? cursor?.sequence
      if (minimumSequence !== undefined
        && compareSequence(frame.resumeAfter.sequence, minimumSequence) < 0) {
        throw new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: 'The resync cursor regressed behind observed stream state.',
          retryable: false,
          terminal: true,
          details: { minimumSequence, resumeAfter: frame.resumeAfter },
        })
      }
      await performResync(context, {
        reason: frame.reason,
        source: 'server',
        streamId: frame.scope.streamId,
        previousCursor: cursor,
        resumeAfter: frame.resumeAfter,
      })
      return
    }

    if (frame.type === 'batch') {
      if (context.replaying && !context.replayThrough) {
        throw new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: 'A replay batch arrived before replay.begin.',
          retryable: false,
          terminal: true,
        })
      }
      for (const event of frame.events) {
        ensureEpoch(context)
        await applyDurableEvent(context, event)
      }
      return
    }

    if (frame.type === 'event') {
      if (frame.delivery === 'ephemeral') {
        const observedEvent = eventForRequiredEffect(frame)
        eventAdvisories(observedEvent)
        observe({ type: 'event', event: observedEvent, cursor: cursor ? { ...cursor } : null })
        return
      }
      if (context.replaying && !context.replayThrough) {
        throw new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: 'A durable replay event arrived before replay.begin.',
          retryable: false,
          terminal: true,
        })
      }
      await applyDurableEvent(context, frame)
    }
  }

  async function processRawMessage(context: ConnectionContext, raw: unknown): Promise<void> {
    ensureEpoch(context)
    const text = await messageText(raw)
    ensureEpoch(context)
    if (text === GSCDUMP_REALTIME_PONG) {
      context.lastPongAt = runtime.now()
      return
    }
    const textBytes = utf8Size(text)
    if (textBytes > GSCDUMP_REALTIME_LIMITS.outboundFrameMaxBytes) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: 'A server frame exceeded the v1 outbound frame limit.',
        retryable: false,
        terminal: true,
      })
    }
    let rawFrame: unknown
    try {
      rawFrame = JSON.parse(text) as unknown
    }
    catch (cause) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: 'The server sent malformed realtime JSON.',
        retryable: false,
        terminal: true,
        cause,
      })
    }
    const parsed = schemas.serverFrame.safeParse(rawFrame)
    if (!parsed.success) {
      throw new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: 'The server frame did not match the v1 protocol.',
        retryable: false,
        terminal: true,
        details: parseErrorDetails(parsed.error),
        cause: parsed.error,
      })
    }
    if (parsed.data.type === 'event') {
      const eventLimit = parsed.data.delivery === 'durable'
        ? GSCDUMP_REALTIME_LIMITS.durableEventMaxBytes
        : GSCDUMP_REALTIME_LIMITS.ephemeralEventMaxBytes
      if (textBytes > eventLimit) {
        throw new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: `A ${parsed.data.delivery} event exceeded its v1 size limit.`,
          retryable: false,
          terminal: true,
        })
      }
    }
    if (parsed.data.type === 'batch') {
      for (const event of parsed.data.events) {
        if (utf8Size(JSON.stringify(event)) > GSCDUMP_REALTIME_LIMITS.durableEventMaxBytes) {
          throw new GscdumpRealtimeV1Error({
            code: 'protocol_error',
            message: 'A durable event inside a batch exceeded its v1 size limit.',
            retryable: false,
            terminal: true,
          })
        }
      }
    }
    await processFrame(context, parsed.data)
  }

  function handleFrameQueueError(context: ConnectionContext, cause: unknown): void {
    if (cause instanceof StaleEpochError || !running || current !== context)
      return
    const error = cause instanceof GscdumpRealtimeV1Error
      ? cause
      : new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: 'Realtime frame processing failed.',
          retryable: false,
          terminal: true,
          cause,
        })
    if (error.terminal) {
      terminal(error, context)
      return
    }
    reportError(error)
    scheduleReconnect(context, error.code)
  }

  async function loadCursor(ticket: RealtimeTicketData): Promise<RealtimeV1Cursor | null> {
    let stored: RealtimeV1Cursor | null
    try {
      stored = await cursorStore.load()
    }
    catch (cause) {
      throw new GscdumpRealtimeV1Error({
        code: 'cursor_store_failed',
        message: 'Could not load the realtime cursor.',
        retryable: false,
        terminal: true,
        cause,
      })
    }
    if (stored === null)
      return null
    const parsed = schemas.cursor.safeParse(stored)
    if (!parsed.success) {
      reportError(new GscdumpRealtimeV1Error({
        code: 'cursor_store_failed',
        message: 'The stored realtime cursor was invalid; a full resync is required.',
        retryable: true,
        terminal: false,
        details: parseErrorDetails(parsed.error),
        cause: parsed.error,
      }))
      return null
    }
    if (parsed.data.streamId !== ticket.head.streamId)
      return null
    return parsed.data
  }

  async function provideFreshTicket(): Promise<RealtimeTicketData> {
    let raw: unknown
    try {
      raw = await options.ticketProvider()
    }
    catch (cause) {
      throw new GscdumpRealtimeV1Error({
        code: 'ticket_provider_failed',
        message: 'The realtime ticket provider rejected.',
        retryable: true,
        terminal: false,
        cause,
      })
    }
    const parsed = schemas.ticketResponseClient.safeParse(raw)
    if (!parsed.success) {
      throw new GscdumpRealtimeV1Error({
        code: 'ticket_invalid',
        message: 'The realtime ticket response did not match the v1 contract.',
        retryable: false,
        terminal: true,
        details: parseErrorDetails(parsed.error),
        cause: parsed.error,
      })
    }
    if (Date.parse(parsed.data.data.expiresAt) <= runtime.now()) {
      throw new GscdumpRealtimeV1Error({
        code: 'ticket_invalid',
        message: 'The realtime ticket had already expired locally.',
        retryable: true,
        terminal: false,
        details: { localExpiry: true },
      })
    }
    return parsed.data.data
  }

  async function beginAttempt(): Promise<void> {
    if (!running)
      return
    const attemptEpoch = ++epoch
    setState('ticketing', freshness === 'fresh' ? 'stale' : freshness)

    let ticket: RealtimeTicketData
    try {
      ticket = await provideFreshTicket()
    }
    catch (cause) {
      if (!running || epoch !== attemptEpoch)
        return
      const error = cause instanceof GscdumpRealtimeV1Error
        ? cause
        : new GscdumpRealtimeV1Error({
            code: 'ticket_provider_failed',
            message: 'Could not obtain a realtime ticket.',
            retryable: true,
            terminal: false,
            cause,
          })
      if (error.code === 'ticket_invalid' && error.details.localExpiry === true && immediateExpiredTicketRetry) {
        immediateExpiredTicketRetry = false
        void beginAttempt()
        return
      }
      reportError(error)
      if (error.terminal)
        terminal(error, null)
      else
        scheduleReconnect(null, error.code)
      return
    }
    immediateExpiredTicketRetry = true
    if (!running || epoch !== attemptEpoch)
      return

    try {
      cursor = await loadCursor(ticket)
    }
    catch (cause) {
      if (!running || epoch !== attemptEpoch)
        return
      terminal(cause as GscdumpRealtimeV1Error, null)
      return
    }
    if (!running || epoch !== attemptEpoch)
      return
    streamId = ticket.head.streamId
    head = { ...ticket.head }
    emitState()

    let socket: GscdumpRealtimeV1SocketLike
    try {
      socket = runtime.createSocket(ticket.socketUrl, [ticket.protocol, ticket.ticket])
    }
    catch (cause) {
      const error = cause instanceof GscdumpRealtimeV1Error
        ? cause
        : new GscdumpRealtimeV1Error({
            code: 'runtime_unavailable',
            message: 'Could not create the realtime WebSocket.',
            retryable: false,
            terminal: true,
            cause,
          })
      terminal(error, null)
      return
    }

    const context: ConnectionContext = {
      epoch: attemptEpoch,
      socket,
      ticket,
      accepted: false,
      ready: false,
      closed: false,
      replaying: false,
      replayThrough: null,
      lastPongAt: runtime.now(),
      head: null,
      retryAfterMs: undefined,
      frameQueue: Promise.resolve(),
    }
    current = context
    setState('connecting', freshness)

    socket.onopen = () => {
      if (!running || current !== context || context.closed)
        return
      context.accepted = true
      if (socket.protocol !== GSCDUMP_REALTIME_SUBPROTOCOL) {
        terminal(new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: 'The WebSocket did not select gscdump.v1.',
          retryable: false,
          terminal: true,
          details: { selectedProtocol: socket.protocol },
        }), context)
        return
      }
      setState('handshaking', cursor ? 'stale' : 'unknown')
      try {
        const hello = schemas.helloFrame.parse({
          type: 'hello',
          protocolVersion: GSCDUMP_REALTIME_PROTOCOL_VERSION,
          sdkVersion,
          resume: cursor,
        })
        sendJson(context, hello)
      }
      catch (cause) {
        handleFrameQueueError(context, cause)
      }
    }

    socket.onmessage = (event) => {
      if (!running || current !== context || context.closed)
        return
      const work = context.frameQueue.then(() => processRawMessage(context, event.data))
      context.frameQueue = work.catch((cause) => {
        handleFrameQueueError(context, cause)
      })
    }

    socket.onerror = (cause) => {
      if (!running || current !== context || context.closed)
        return
      const error = new GscdumpRealtimeV1Error({
        code: context.accepted ? 'socket_error' : 'upgrade_rejected',
        message: context.accepted
          ? 'The accepted realtime socket emitted an opaque error.'
          : 'The realtime WebSocket upgrade was rejected or failed opaquely.',
        retryable: true,
        terminal: false,
        cause,
      })
      reportError(error)
      scheduleReconnect(context, error.code)
    }

    socket.onclose = (event) => {
      if (context.closed || current !== context)
        return
      current = null
      epoch++
      clearConnectionTimers()
      const code = event.code ?? 1006
      if (!running)
        return
      if (!context.accepted) {
        const error = new GscdumpRealtimeV1Error({
          code: 'upgrade_rejected',
          message: 'The realtime WebSocket upgrade failed opaquely.',
          retryable: true,
          terminal: false,
          details: { closeCode: code },
        })
        reportError(error)
        scheduleReconnect(null, 'upgrade-rejected')
        return
      }
      if (code === GSCDUMP_REALTIME_CLOSE_CODES.normal) {
        running = false
        setState('stopped', 'unknown')
        return
      }
      if (code === GSCDUMP_REALTIME_CLOSE_CODES.protocolError || code === GSCDUMP_REALTIME_CLOSE_CODES.policyViolation) {
        terminal(new GscdumpRealtimeV1Error({
          code: 'protocol_error',
          message: `The realtime server closed with terminal code ${code}.`,
          retryable: false,
          terminal: true,
          details: { closeCode: code, reason: event.reason },
        }), null)
        return
      }
      if (code === GSCDUMP_REALTIME_CLOSE_CODES.maximumLifetime) {
        scheduleReconnect(null, 'maximum-lifetime', 0, true)
        return
      }
      if (code === 1006
        || code === GSCDUMP_REALTIME_CLOSE_CODES.internalError
        || code === GSCDUMP_REALTIME_CLOSE_CODES.serviceRestart
        || code === GSCDUMP_REALTIME_CLOSE_CODES.overloadedOrAckLag) {
        scheduleReconnect(null, `close-${code}`, context.retryAfterMs)
        return
      }
      terminal(new GscdumpRealtimeV1Error({
        code: 'protocol_error',
        message: `The realtime server used an unsupported close code ${code}.`,
        retryable: false,
        terminal: true,
        details: { closeCode: code, reason: event.reason },
      }), null)
    }
  }

  async function start(): Promise<void> {
    if (running)
      return
    running = true
    attempt = 0
    lastError = null
    immediateExpiredTicketRetry = true
    freshness = cursor ? 'stale' : 'unknown'
    await beginAttempt()
  }

  function stop(): void {
    running = false
    clearTimer(reconnectTimer)
    reconnectTimer = undefined
    if (current)
      closeSocket(current, GSCDUMP_REALTIME_CLOSE_CODES.normal, 'manual')
    else
      epoch++
    setState('stopped', 'unknown')
  }

  return { start, stop, getSnapshot }
}
