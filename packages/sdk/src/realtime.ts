import type { PartnerRealtimeEvent, PartnerRealtimeMessage } from '@gscdump/contracts'
import { partnerRoutes } from '@gscdump/contracts/partner'

export type PartnerRealtimeScope = 'partner' | 'user'
export type PartnerRealtimeStatus = 'idle' | 'connecting' | 'open' | 'authenticated' | 'closed' | 'error'
export type PartnerRealtimeHandler<T> = (value: T) => void

export interface PartnerWebSocketLike {
  readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

export interface PartnerWebSocketConstructor {
  new(url: string, protocols?: string | string[]): PartnerWebSocketLike
}

export interface PartnerRealtimeReconnectOptions {
  /** Default `true`. Set `false` to disable automatic reconnection entirely. */
  enabled?: boolean
  /** First-retry delay in ms; doubles each attempt. Default `1000`. */
  baseDelayMs?: number
  /** Upper bound on the backoff delay in ms. Default `30000`. */
  maxDelayMs?: number
  /** Stop after this many consecutive failed attempts. Default `Infinity`. */
  maxRetries?: number
  /** Apply equal-jitter to each delay so many clients don't reconnect in lockstep. Default `true`. */
  jitter?: boolean
}

export interface PartnerRealtimeOptions {
  /**
   * HTTP API base used only to derive a same-origin websocket base when `wsBase`
   * is omitted. Prefer passing `wsBase` when the websocket origin differs.
   */
  apiBase?: string
  /** WebSocket origin base, for example `wss://origin.example`. */
  wsBase?: string
  /** Partner or user API key sent in the first auth message. */
  apiKey: string
  /** `/ws/partner` or `/ws/user`. User scope supports partner key + user id. */
  scope?: PartnerRealtimeScope
  /** Required by the hosted `/ws/user` route when authenticating with a partner API key. */
  userId?: number | string
  /** Optional initial site filter sent after authentication succeeds. */
  siteIds?: string[]
  protocols?: string | string[]
  WebSocket?: PartnerWebSocketConstructor
  /**
   * Automatic reconnection on unexpected close (network drop, server restart).
   * A raw WebSocket `error` Event carries no actionable detail, so rather than
   * surfacing it the client transparently reconnects with exponential backoff.
   * `true` (default) uses defaults; pass an object to tune; `false` disables.
   * The backoff counter resets once a reconnection reaches `authenticated`.
   */
  reconnect?: boolean | PartnerRealtimeReconnectOptions
  /** Injected timer hooks (for tests). Defaults to global `setTimeout`/`clearTimeout`. */
  setTimeout?: (handler: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

interface ResolvedReconnect {
  enabled: boolean
  baseDelayMs: number
  maxDelayMs: number
  maxRetries: number
  jitter: boolean
}

function resolveReconnect(reconnect: PartnerRealtimeOptions['reconnect']): ResolvedReconnect {
  const opts = reconnect === false ? { enabled: false } : reconnect === true || reconnect == null ? {} : reconnect
  return {
    enabled: opts.enabled ?? true,
    baseDelayMs: opts.baseDelayMs ?? 1000,
    maxDelayMs: opts.maxDelayMs ?? 30000,
    maxRetries: opts.maxRetries ?? Number.POSITIVE_INFINITY,
    jitter: opts.jitter ?? true,
  }
}

export interface PartnerRealtimeClient {
  readonly status: PartnerRealtimeStatus
  readonly socket: PartnerWebSocketLike | null
  connect: () => PartnerWebSocketLike
  close: (code?: number, reason?: string) => void
  ping: () => void
  subscribe: (siteIds: string[]) => void
  onStatus: (handler: PartnerRealtimeHandler<PartnerRealtimeStatus>) => () => void
  onMessage: (handler: PartnerRealtimeHandler<PartnerRealtimeMessage>) => () => void
  onEvent: (handler: PartnerRealtimeHandler<PartnerRealtimeEvent>) => () => void
  onError: (handler: PartnerRealtimeHandler<unknown>) => () => void
}

const HTTP_PROTOCOL_RE = /^http/i
const API_SUFFIX_RE = /\/api\/?$/
const TRAILING_SLASH_RE = /\/+$/

function inferWsBase(options: PartnerRealtimeOptions): string {
  if (options.wsBase)
    return options.wsBase.replace(TRAILING_SLASH_RE, '')
  if (!options.apiBase)
    return ''
  const origin = options.apiBase.replace(API_SUFFIX_RE, '').replace(TRAILING_SLASH_RE, '')
  return origin.replace(HTTP_PROTOCOL_RE, m => m.toLowerCase() === 'https' ? 'wss' : 'ws')
}

function wsPath(scope: PartnerRealtimeScope): string {
  return scope === 'partner' ? partnerRoutes.realtime.partner : partnerRoutes.realtime.user
}

function buildWsUrl(options: PartnerRealtimeOptions): string {
  const scope = options.scope ?? 'partner'
  const base = inferWsBase(options)
  if (!base)
    return wsPath(scope)
  return `${base}${wsPath(scope)}`
}

function parseMessage(raw: unknown): PartnerRealtimeMessage | null {
  if (typeof raw !== 'string')
    return null
  try {
    return JSON.parse(raw) as PartnerRealtimeMessage
  }
  catch {
    return null
  }
}

function isRealtimeEvent(message: PartnerRealtimeMessage): message is PartnerRealtimeEvent {
  return 'event' in message
    && message.event !== 'auth.required'
    && message.event !== 'connected'
}

function getWebSocketCtor(options: PartnerRealtimeOptions): PartnerWebSocketConstructor {
  const ctor = options.WebSocket ?? globalThis.WebSocket
  // Programmer/environment-setup invariant (no `WebSocket` constructor available
  // and none injected), not a recoverable domain failure: keep throwing.
  if (!ctor)
    throw new Error('WebSocket is not available; pass options.WebSocket')
  return ctor as PartnerWebSocketConstructor
}

export function createPartnerRealtimeClient(options: PartnerRealtimeOptions): PartnerRealtimeClient {
  let socket: PartnerWebSocketLike | null = null
  let status: PartnerRealtimeStatus = 'idle'

  const reconnect = resolveReconnect(options.reconnect)
  const setTimer = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let manualClose = false
  let reconnectAttempts = 0
  let reconnectTimer: unknown = null

  const statusHandlers = new Set<PartnerRealtimeHandler<PartnerRealtimeStatus>>()
  const messageHandlers = new Set<PartnerRealtimeHandler<PartnerRealtimeMessage>>()
  const eventHandlers = new Set<PartnerRealtimeHandler<PartnerRealtimeEvent>>()
  const errorHandlers = new Set<PartnerRealtimeHandler<unknown>>()

  function setStatus(next: PartnerRealtimeStatus): void {
    status = next
    for (const handler of statusHandlers)
      handler(next)
  }

  function sendJson(payload: unknown): void {
    // Programmer invariant: `ping`/`subscribe`/auth was called before `connect`.
    // A misuse of the client lifecycle, not a recoverable domain failure: throw.
    if (!socket)
      throw new Error('Partner realtime client is not connected')
    socket.send(JSON.stringify(payload))
  }

  function authPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { type: 'auth', apiKey: options.apiKey }
    if (options.userId != null)
      payload.userId = options.userId
    return payload
  }

  function subscribe(siteIds: string[]): void {
    sendJson({ type: 'subscribe', siteIds })
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer != null) {
      clearTimer(reconnectTimer)
      reconnectTimer = null
    }
  }

  function backoffDelay(attempt: number): number {
    const exp = Math.min(reconnect.maxDelayMs, reconnect.baseDelayMs * 2 ** attempt)
    if (!reconnect.jitter)
      return exp
    // Equal jitter: half fixed, half random, so reconnects spread out without
    // collapsing to near-zero delay.
    return Math.round(exp / 2 + Math.random() * (exp / 2))
  }

  // Extracted from `client.connect` so the reconnect timer can re-open the
  // socket without referencing the `client` const before it's defined.
  function openSocket(): PartnerWebSocketLike {
    if (socket)
      return socket
    // A fresh connect cancels any pending reconnect and re-arms the channel.
    clearReconnectTimer()
    manualClose = false
    const WebSocketImpl = getWebSocketCtor(options)
    socket = new WebSocketImpl(buildWsUrl(options), options.protocols)
    setStatus('connecting')

    socket.onopen = () => {
      setStatus('open')
      sendJson(authPayload())
    }
    socket.onmessage = (event) => {
      const message = parseMessage(event.data)
      if (!message)
        return
      if ('event' in message && message.event === 'connected') {
        // Reconnection succeeded → reset backoff so the next drop starts fresh.
        reconnectAttempts = 0
        setStatus('authenticated')
        if (options.siteIds?.length)
          subscribe(options.siteIds)
      }
      for (const handler of messageHandlers)
        handler(message)
      if (isRealtimeEvent(message)) {
        for (const handler of eventHandlers)
          handler(message)
      }
    }
    socket.onerror = (event) => {
      setStatus('error')
      for (const handler of errorHandlers)
        handler(event)
    }
    socket.onclose = (event) => {
      socket = null
      setStatus('closed')
      for (const handler of messageHandlers) {
        handler({ type: 'error', message: `WebSocket closed: ${JSON.stringify(event)}` })
      }
      // Unexpected drop (not a caller-initiated close) → reconnect with backoff.
      scheduleReconnect()
    }
    return socket
  }

  function scheduleReconnect(): void {
    if (!reconnect.enabled || manualClose || reconnectTimer != null)
      return
    if (reconnectAttempts >= reconnect.maxRetries) {
      // Genuinely terminal: backoff exhausted. Hand consumers a real Error
      // (not the opaque close Event) so it can be surfaced/logged meaningfully.
      const err = new Error(`Partner realtime reconnect exhausted after ${reconnectAttempts} attempts`)
      for (const handler of errorHandlers)
        handler(err)
      return
    }
    const delay = backoffDelay(reconnectAttempts)
    reconnectAttempts += 1
    setStatus('connecting')
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      openSocket()
    }, delay)
  }

  const client: PartnerRealtimeClient = {
    get status() {
      return status
    },
    get socket() {
      return socket
    },
    connect() {
      return openSocket()
    },
    close(code?: number, reason?: string) {
      manualClose = true
      clearReconnectTimer()
      socket?.close(code, reason)
      socket = null
      setStatus('closed')
    },
    ping() {
      sendJson({ type: 'ping' })
    },
    subscribe,
    onStatus(handler) {
      statusHandlers.add(handler)
      return () => statusHandlers.delete(handler)
    },
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onEvent(handler) {
      eventHandlers.add(handler)
      return () => eventHandlers.delete(handler)
    },
    onError(handler) {
      errorHandlers.add(handler)
      return () => errorHandlers.delete(handler)
    },
  }

  return client
}

export const createGscdumpRealtimeClient = createPartnerRealtimeClient
