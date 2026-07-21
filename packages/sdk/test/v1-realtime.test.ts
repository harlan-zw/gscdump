import type { RealtimeV1Cursor, RealtimeV1Event } from '@gscdump/contracts/v1'
import type {
  GscdumpRealtimeV1CursorStore,
  GscdumpRealtimeV1Observation,
  GscdumpRealtimeV1Runtime,
  GscdumpRealtimeV1SocketLike,
} from '@gscdump/sdk/v1'
import {
  createGscdumpRealtimeV1Client,
  GSCDUMP_REALTIME_V1_SDK_VERSION,
} from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'
import sdkPackage from '../package.json'

const STREAM = 'user:u_test' as const
const SECOND_STREAM = 'user:u_other' as const

async function settle(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index++)
    await Promise.resolve()
}

async function settleUntil(predicate: () => boolean, turns = 200): Promise<void> {
  for (let index = 0; index < turns && !predicate(); index++)
    await Promise.resolve()
}

class FakeSocket implements GscdumpRealtimeV1SocketLike {
  readyState = 0
  protocol = ''
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number, reason?: string, wasClean?: boolean }) => void) | null = null
  readonly sent: string[] = []
  readonly closes: Array<{ code?: number, reason?: string }> = []
  onSend: ((data: string) => void) | undefined

  constructor(
    readonly url: string,
    readonly protocols: readonly string[],
  ) {}

  open(protocol = 'gscdump.v1'): void {
    this.protocol = protocol
    this.readyState = 1
    this.onopen?.({})
  }

  send(data: string): void {
    if (this.readyState !== 1)
      throw new Error('socket is not open')
    this.sent.push(data)
    this.onSend?.(data)
  }

  message(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value)
    this.onmessage?.({ data })
  }

  error(value: unknown = new Error('opaque socket failure')): void {
    this.onerror?.(value)
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason, wasClean: code === 1000 })
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.closes.push({ code, reason })
  }
}

class FakeRuntime implements GscdumpRealtimeV1Runtime {
  nowMs = Date.parse('2026-07-14T08:00:00.000Z')
  randomValue = 0
  readonly sockets: FakeSocket[] = []
  private timerId = 0
  private readonly timers = new Map<number, { at: number, handler: () => void }>()

  createSocket = (url: string, protocols: readonly string[]): FakeSocket => {
    const socket = new FakeSocket(url, protocols)
    this.sockets.push(socket)
    return socket
  }

  setTimeout = (handler: () => void, ms: number): number => {
    const id = ++this.timerId
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), handler })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  random = (): number => this.randomValue
  now = (): number => this.nowMs

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next)
        break
      const [id, timer] = next
      this.timers.delete(id)
      this.nowMs = timer.at
      timer.handler()
      await settle()
    }
    this.nowMs = target
    await settle()
  }
}

class MemoryCursorStore implements GscdumpRealtimeV1CursorStore {
  readonly saves: RealtimeV1Cursor[] = []

  constructor(
    public value: RealtimeV1Cursor | null,
    private readonly rejectSave = false,
  ) {}

  load = (): RealtimeV1Cursor | null => this.value ? { ...this.value } : null

  save = async (cursor: RealtimeV1Cursor): Promise<void> => {
    this.saves.push({ ...cursor })
    if (this.rejectSave)
      throw new Error('cursor store unavailable')
    this.value = { ...cursor }
  }
}

function ticket(
  runtime: FakeRuntime,
  sequence: string,
  serial = 1,
  streamId: RealtimeV1Cursor['streamId'] = STREAM,
): unknown {
  return {
    data: {
      socketUrl: 'wss://gscdump.com/ws/v1',
      protocol: 'gscdump.v1',
      protocolVersion: 1,
      ticket: `gscdump.ticket.v1.payload${serial}.signature${serial}`,
      expiresAt: new Date(runtime.nowMs + 60_000).toISOString(),
      head: { streamId, sequence },
      maxConnectionSeconds: 900,
    },
    meta: { requestId: `req_ticket_${serial}`, surface: 'realtime', version: '1.0' },
  }
}

function ready(
  runtime: FakeRuntime,
  headSequence: string,
  replayFloorSequence = '0',
  expiresInMs = 600_000,
  streamId: RealtimeV1Cursor['streamId'] = STREAM,
): unknown {
  return {
    type: 'ready',
    protocolVersion: 1,
    connectionId: 'conn_test',
    streamId,
    head: { streamId, sequence: headSequence },
    replayFloor: { streamId, sequence: replayFloorSequence },
    limits: { maxBatchEvents: 20, maxUnackedEvents: 500 },
    heartbeat: { ping: 'ping', pong: 'pong' },
    expiresAt: new Date(runtime.nowMs + expiresInMs).toISOString(),
  }
}

function durableEvent(
  sequence: string,
  options: {
    data?: RealtimeV1Event['data']
    eventVersion?: number
    id?: string
    name?: string
    resource?: string
    streamId?: RealtimeV1Cursor['streamId']
  } = {},
): Extract<RealtimeV1Event, { delivery: 'durable' }> {
  return {
    type: 'event',
    protocolVersion: 1,
    eventVersion: options.eventVersion ?? 1,
    id: options.id ?? `evt_${sequence}`,
    name: options.name ?? 'site.lifecycle.changed',
    cursor: { streamId: options.streamId ?? STREAM, sequence },
    subject: { type: 'site', id: 's_test' },
    changes: [{ type: options.resource ?? 'site.lifecycle', id: 's_test', kind: 'updated' }],
    occurredAt: '2026-07-14T08:00:00.000Z',
    correlationId: null,
    delivery: 'durable',
    data: options.data ?? {},
  }
}

function ephemeralEvent(): Extract<RealtimeV1Event, { delivery: 'ephemeral' }> {
  return {
    type: 'event',
    protocolVersion: 1,
    eventVersion: 1,
    id: 'evt_progress',
    name: 'site.lifecycle.progress',
    cursor: null,
    subject: { type: 'site', id: 's_test' },
    changes: [],
    occurredAt: '2026-07-14T08:00:00.000Z',
    correlationId: null,
    delivery: 'ephemeral',
    data: { percent: 50 },
  }
}

function ackSequences(socket: FakeSocket): string[] {
  return socket.sent
    .filter(value => value.startsWith('{'))
    .map(value => JSON.parse(value) as { type: string, cursor?: RealtimeV1Cursor })
    .filter(frame => frame.type === 'ack')
    .map(frame => frame.cursor!.sequence)
}

describe('@gscdump/sdk/v1 realtime state machine', () => {
  it('advertises the published SDK version in its default hello frame', () => {
    expect(GSCDUMP_REALTIME_V1_SDK_VERSION).toBe(sdkPackage.version)
  })

  it('gets a fresh ticket per attempt and opens with only the v1 protocol plus ticket', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    let ticketCalls = 0
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '0', ++ticketCalls),
      applyEvent: async () => {},
      resync: async () => {},
    })

    await client.start()
    const first = runtime.sockets[0]!
    expect(first.protocols).toEqual(['gscdump.v1', 'gscdump.ticket.v1.payload1.signature1'])
    expect(first.url).toBe('wss://gscdump.com/ws/v1')
    first.open()
    expect(JSON.parse(first.sent[0]!)).toEqual({
      type: 'hello',
      protocolVersion: 1,
      sdkVersion: GSCDUMP_REALTIME_V1_SDK_VERSION,
      resume: { streamId: STREAM, sequence: '0' },
    })
    first.message(ready(runtime, '0'))
    await settle()
    expect(client.getSnapshot()).toMatchObject({ transport: 'live', freshness: 'fresh' })

    first.serverClose(1012, 'deploy')
    await runtime.advance(500)
    expect(ticketCalls).toBe(2)
    expect(runtime.sockets[1]!.protocols[1]).toBe('gscdump.ticket.v1.payload2.signature2')
  })

  it('applies replay and batches in FIFO order, deduplicates, then ACKs cumulatively', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    const applied: string[] = []
    const observations: GscdumpRealtimeV1Observation[] = []
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '3'),
      applyEvent: async event => void applied.push(event.cursor!.sequence),
      resync: async () => {},
      onObservation: observation => observations.push(observation),
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '3'))
    socket.message({
      type: 'replay.begin',
      after: { streamId: STREAM, sequence: '0' },
      through: { streamId: STREAM, sequence: '3' },
    })
    socket.message({ type: 'batch', events: [durableEvent('1'), durableEvent('2')] })
    socket.message(durableEvent('2'))
    socket.message(durableEvent('3', {
      id: 'evt_unknown',
      name: 'site.future.ready',
      resource: 'site.future',
    }))
    socket.message({ type: 'replay.end', through: { streamId: STREAM, sequence: '3' } })
    await settleUntil(() => applied.length === 3 && client.getSnapshot().freshness === 'fresh')

    expect(applied).toEqual(['1', '2', '3'])
    expect(store.value).toEqual({ streamId: STREAM, sequence: '3' })
    expect(ackSequences(socket)).toEqual(['1', '2', '2', '3'])
    expect(client.getSnapshot()).toMatchObject({ transport: 'live', freshness: 'fresh' })
    expect(observations).toContainEqual(expect.objectContaining({ type: 'advisory', code: 'unknown_event' }))
    expect(observations).toContainEqual(expect.objectContaining({ type: 'advisory', code: 'unknown_resource' }))
  })

  it('never declares a truncated replay fresh and resyncs to the advertised head', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    const applyEvent = vi.fn(async () => {})
    const resync = vi.fn(async () => {})
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '3'),
      applyEvent,
      resync,
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '3'))
    socket.message({
      type: 'replay.begin',
      after: { streamId: STREAM, sequence: '0' },
      through: { streamId: STREAM, sequence: '3' },
    })
    socket.message(durableEvent('1'))
    socket.message({ type: 'replay.end', through: { streamId: STREAM, sequence: '1' } })
    await settleUntil(() => resync.mock.calls.length === 1)

    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(ackSequences(socket)).toEqual(['1'])
    expect(resync).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'sequence_gap',
      resumeAfter: { streamId: STREAM, sequence: '3' },
    }))
    expect(store.value).toEqual({ streamId: STREAM, sequence: '3' })
    expect(client.getSnapshot().freshness).not.toBe('fresh')
  })

  it('rejects replay delivery before replay.begin without applying, saving, or ACKing', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    const applyEvent = vi.fn(async () => {})
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '1'),
      applyEvent,
      resync: async () => {},
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '1'))
    socket.message(durableEvent('1'))
    await settle()

    expect(applyEvent).not.toHaveBeenCalled()
    expect(store.saves).toEqual([])
    expect(ackSequences(socket)).toEqual([])
    expect(client.getSnapshot()).toMatchObject({
      transport: 'terminal',
      freshness: 'degraded',
      error: { code: 'protocol_error' },
    })
  })

  it('orders the required effect, cursor save, ACK, and observation exactly', async () => {
    const runtime = new FakeRuntime()
    const order: string[] = []
    let stored: RealtimeV1Cursor = { streamId: STREAM, sequence: '0' }
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: {
        load: () => ({ ...stored }),
        save: async (next) => {
          order.push(`save:${next.sequence}`)
          stored = { ...next }
        },
      },
      ticketProvider: () => ticket(runtime, '0'),
      applyEvent: async (event) => {
        order.push(`apply:${event.cursor!.sequence}`)
      },
      resync: async () => {},
      onObservation(observation) {
        if (observation.type === 'event')
          order.push(`observe:${observation.cursor!.sequence}`)
      },
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.onSend = (data) => {
      if (data.startsWith('{') && (JSON.parse(data) as { type: string }).type === 'ack')
        order.push(`ack:${(JSON.parse(data) as { cursor: RealtimeV1Cursor }).cursor.sequence}`)
    }
    socket.open()
    socket.message(ready(runtime, '0'))
    socket.message(durableEvent('1'))
    await settleUntil(() => order.includes('observe:1'))

    expect(order).toEqual(['apply:1', 'save:1', 'ack:1', 'observe:1'])
  })

  it('scopes event-id deduplication to the exact principal stream', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    const applyEvent = vi.fn(async () => {})
    let activeStream: RealtimeV1Cursor['streamId'] = STREAM
    let serial = 0
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '0', ++serial, activeStream),
      applyEvent,
      resync: async () => {},
    })

    await client.start()
    const first = runtime.sockets[0]!
    first.open()
    first.message(ready(runtime, '0', '0', 600_000, STREAM))
    first.message(durableEvent('1', { id: 'evt_shared', streamId: STREAM }))
    await settleUntil(() => applyEvent.mock.calls.length === 1)
    client.stop()

    activeStream = SECOND_STREAM
    store.value = { streamId: SECOND_STREAM, sequence: '0' }
    await client.start()
    const second = runtime.sockets[1]!
    second.open()
    second.message(ready(runtime, '0', '0', 600_000, SECOND_STREAM))
    second.message(durableEvent('1', { id: 'evt_shared', streamId: SECOND_STREAM }))
    await settleUntil(() => ackSequences(second).length === 1)

    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(store.value).toEqual({ streamId: SECOND_STREAM, sequence: '1' })
    expect(ackSequences(second)).toEqual(['1'])
  })

  it('ignores unsupported payload data while preserving required base changes', async () => {
    const runtime = new FakeRuntime()
    const applied: RealtimeV1Event[] = []
    const observations: GscdumpRealtimeV1Observation[] = []
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '0' }),
      ticketProvider: () => ticket(runtime, '0'),
      applyEvent: async event => void applied.push(event),
      resync: async () => {},
      onObservation: observation => observations.push(observation),
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '0'))
    socket.message(durableEvent('1', {
      id: 'evt_unknown',
      name: 'site.future.ready',
      resource: 'site.future',
      data: { unsafeInstruction: true },
    }))
    socket.message(durableEvent('2', {
      id: 'evt_future_version',
      eventVersion: 2,
      data: { futureShape: true },
    }))
    await settleUntil(() => observations.some(
      observation => observation.type === 'advisory' && observation.code === 'unsupported_event_version',
    ))

    expect(applied.map(event => event.data)).toEqual([null, null])
    expect(applied[0]!.changes).toEqual([expect.objectContaining({ type: 'site.future' })])
    expect(observations).toContainEqual(expect.objectContaining({ type: 'advisory', code: 'unknown_event' }))
    expect(observations).toContainEqual(expect.objectContaining({ type: 'advisory', code: 'unknown_resource' }))
    expect(observations).toContainEqual(expect.objectContaining({ type: 'advisory', code: 'unsupported_event_version' }))
  })

  it('measures standalone event bounds from the received UTF-8 frame', async () => {
    const runtime = new FakeRuntime()
    const applyEvent = vi.fn(async () => {})
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '0' }),
      ticketProvider: () => ticket(runtime, '0'),
      applyEvent,
      resync: async () => {},
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '0'))
    socket.message(`${' '.repeat(65_536)}${JSON.stringify(durableEvent('1'))}`)
    await settle()

    expect(applyEvent).not.toHaveBeenCalled()
    expect(client.getSnapshot()).toMatchObject({
      transport: 'terminal',
      error: { code: 'protocol_error' },
    })
  })

  it('resyncs an unrecoverable local gap without applying or ACKing across it', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    const applyEvent = vi.fn(async () => {})
    const resync = vi.fn(async () => {})
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '0'),
      applyEvent,
      resync,
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '0'))
    socket.message(durableEvent('2'))
    await settle(24)

    expect(applyEvent).not.toHaveBeenCalled()
    expect(resync).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'sequence_gap',
      previousCursor: { streamId: STREAM, sequence: '0' },
      resumeAfter: { streamId: STREAM, sequence: '2' },
    }))
    expect(store.value).toEqual({ streamId: STREAM, sequence: '2' })
    expect(ackSequences(socket)).toEqual([])
  })

  it('retries the same rejected effect three times, never ACKs it, then performs unsafe resync', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    const applyEvent = vi.fn(async () => {
      throw new Error('cache refresh failed')
    })
    const resync = vi.fn(async () => {})
    let ticketCalls = 0
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '0', ++ticketCalls),
      applyEvent,
      resync,
    })

    await client.start()
    for (let failure = 0; failure < 3; failure++) {
      const socket = runtime.sockets[failure]!
      socket.open()
      socket.message(ready(runtime, '0'))
      socket.message(durableEvent('1'))
      await settle(20)
      expect(ackSequences(socket)).toEqual([])
      if (failure < 2)
        await runtime.advance(500)
    }

    expect(applyEvent).toHaveBeenCalledTimes(3)
    expect(resync).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'effect_application_failed',
      failedEvent: expect.objectContaining({ id: 'evt_1' }),
      resumeAfter: { streamId: STREAM, sequence: '1' },
    }))
    expect(store.value).toEqual({ streamId: STREAM, sequence: '1' })
  })

  it('does not ACK when the cursor store rejects after the required effect', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' }, true)
    const applyEvent = vi.fn(async () => {})
    const observations: GscdumpRealtimeV1Observation[] = []
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '0'),
      applyEvent,
      resync: async () => {},
      onObservation: observation => observations.push(observation),
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '0'))
    socket.message(durableEvent('1'))
    await settle(20)

    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(store.value).toEqual({ streamId: STREAM, sequence: '0' })
    expect(ackSequences(socket)).toEqual([])
    expect(observations).toContainEqual(expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({ code: 'cursor_store_failed' }),
    }))
  })

  it('prevents stale epoch work from saving or ACKing after stop', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    let resolveApply!: () => void
    const applyPending = new Promise<void>((resolve) => {
      resolveApply = resolve
    })
    const applyEvent = vi.fn(() => applyPending)
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '0'),
      applyEvent,
      resync: async () => {},
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '0'))
    socket.message(durableEvent('1'))
    await settle()
    expect(applyEvent).toHaveBeenCalledTimes(1)

    client.stop()
    resolveApply()
    await settle(20)
    expect(store.saves).toEqual([])
    expect(ackSequences(socket)).toEqual([])
    expect(client.getSnapshot()).toMatchObject({ transport: 'stopped' })
  })

  it('keeps ephemeral progress observational and isolated from cursor/application effects', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    const applyEvent = vi.fn(async () => {})
    const observed: RealtimeV1Event[] = []
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '0'),
      applyEvent,
      resync: async () => {},
      onObservation(observation) {
        if (observation.type === 'event')
          observed.push(observation.event)
        throw new Error('observer failure must be isolated')
      },
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '0'))
    socket.message(ephemeralEvent())
    await settle(20)

    expect(observed).toEqual([expect.objectContaining({ delivery: 'ephemeral' })])
    expect(applyEvent).not.toHaveBeenCalled()
    expect(store.saves).toEqual([])
    expect(ackSequences(socket)).toEqual([])
    expect(client.getSnapshot()).toMatchObject({ transport: 'live', freshness: 'fresh' })
  })

  it('adopts a missing initial cursor only after successful resync, then reconnects', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore(null)
    const resync = vi.fn(async () => {})
    let ticketCalls = 0
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '5', ++ticketCalls),
      applyEvent: async () => {},
      resync,
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    expect(JSON.parse(socket.sent[0]!).resume).toBeNull()
    socket.message(ready(runtime, '5'))
    await settle(20)

    expect(resync).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'initial_cursor_missing',
      previousCursor: null,
      resumeAfter: { streamId: STREAM, sequence: '5' },
    }))
    expect(store.value).toEqual({ streamId: STREAM, sequence: '5' })
    await runtime.advance(0)
    expect(ticketCalls).toBe(2)
  })

  it('does not adopt a pending resync after stop, even when it later rejects', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore(null)
    let rejectResync!: (cause: unknown) => void
    const resync = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectResync = reject
    }))
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '5'),
      applyEvent: async () => {},
      resync,
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '5'))
    await settleUntil(() => resync.mock.calls.length === 1)
    client.stop()
    rejectResync(new Error('late resync rejection'))
    await settle()

    expect(store.saves).toEqual([])
    expect(client.getSnapshot()).toMatchObject({ transport: 'stopped', freshness: 'unknown' })
  })

  it('rejects ready and resync cursors that regress observed stream state', async () => {
    const readyRuntime = new FakeRuntime()
    const readyResync = vi.fn(async () => {})
    const readyClient = createGscdumpRealtimeV1Client({
      runtime: readyRuntime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '5' }),
      ticketProvider: () => ticket(readyRuntime, '5'),
      applyEvent: async () => {},
      resync: readyResync,
    })
    await readyClient.start()
    readyRuntime.sockets[0]!.open()
    readyRuntime.sockets[0]!.message(ready(readyRuntime, '4'))
    await settle()
    expect(readyResync).not.toHaveBeenCalled()
    expect(readyClient.getSnapshot()).toMatchObject({ transport: 'terminal', error: { code: 'protocol_error' } })

    const resyncRuntime = new FakeRuntime()
    const resync = vi.fn(async () => {})
    const resyncClient = createGscdumpRealtimeV1Client({
      runtime: resyncRuntime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '5' }),
      ticketProvider: () => ticket(resyncRuntime, '5'),
      applyEvent: async () => {},
      resync,
    })
    await resyncClient.start()
    resyncRuntime.sockets[0]!.open()
    resyncRuntime.sockets[0]!.message(ready(resyncRuntime, '5'))
    resyncRuntime.sockets[0]!.message({
      type: 'resync.required',
      reason: 'sequence_gap',
      scope: { type: 'stream', streamId: STREAM },
      resumeAfter: { streamId: STREAM, sequence: '4' },
    })
    await settle()
    expect(resync).not.toHaveBeenCalled()
    expect(resyncClient.getSnapshot()).toMatchObject({ transport: 'terminal', error: { code: 'protocol_error' } })
  })

  it('keeps the old cursor and reports terminal degraded state when resync rejects', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '4'),
      applyEvent: async () => {},
      resync: async () => {
        throw new Error('authoritative reseed failed')
      },
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message(ready(runtime, '4'))
    socket.message({
      type: 'resync.required',
      reason: 'retention_gap',
      scope: { type: 'stream', streamId: STREAM },
      resumeAfter: { streamId: STREAM, sequence: '4' },
    })
    await settle(20)

    expect(store.value).toEqual({ streamId: STREAM, sequence: '0' })
    expect(client.getSnapshot()).toMatchObject({
      transport: 'terminal',
      freshness: 'degraded',
      cursor: { sequence: '0' },
      head: { sequence: '4' },
      error: { code: 'resync_failed' },
    })
  })

  it('owns heartbeat stale detection and rotates before the signed ready expiry', async () => {
    const runtime = new FakeRuntime()
    const store = new MemoryCursorStore({ streamId: STREAM, sequence: '0' })
    let ticketCalls = 0
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: store,
      ticketProvider: () => ticket(runtime, '0', ++ticketCalls),
      applyEvent: async () => {},
      resync: async () => {},
    })

    await client.start()
    const first = runtime.sockets[0]!
    first.open()
    first.message(ready(runtime, '0', '0', 60_000))
    await settle()
    await runtime.advance(25_000)
    expect(first.sent.at(-1)).toBe('ping')
    first.message('pong')
    await settle()

    // Rotation is scheduled 30 seconds before the signed expiry.
    await runtime.advance(5_000)
    expect(ticketCalls).toBe(2)

    const second = runtime.sockets[1]!
    second.open()
    second.message(ready(runtime, '0'))
    await settle()
    await runtime.advance(75_000)
    expect(client.getSnapshot()).toMatchObject({ transport: 'waiting', freshness: 'stale' })
    expect(client.getSnapshot().error?.code).toBe('heartbeat_stale')
  })

  it('enforces terminal and retrying close policy, including framed Retry-After', async () => {
    const terminalRuntime = new FakeRuntime()
    const terminalClient = createGscdumpRealtimeV1Client({
      runtime: terminalRuntime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '0' }),
      ticketProvider: () => ticket(terminalRuntime, '0'),
      applyEvent: async () => {},
      resync: async () => {},
    })
    await terminalClient.start()
    terminalRuntime.sockets[0]!.open()
    terminalRuntime.sockets[0]!.serverClose(1002, 'bad protocol')
    expect(terminalClient.getSnapshot()).toMatchObject({ transport: 'terminal', error: { code: 'protocol_error' } })

    const lifetimeRuntime = new FakeRuntime()
    let lifetimeTickets = 0
    const lifetimeClient = createGscdumpRealtimeV1Client({
      runtime: lifetimeRuntime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '0' }),
      ticketProvider: () => ticket(lifetimeRuntime, '0', ++lifetimeTickets),
      applyEvent: async () => {},
      resync: async () => {},
    })
    await lifetimeClient.start()
    lifetimeRuntime.sockets[0]!.open()
    lifetimeRuntime.sockets[0]!.serverClose(4001, 'maximum lifetime')
    await lifetimeRuntime.advance(0)
    expect(lifetimeTickets).toBe(2)

    const retryRuntime = new FakeRuntime()
    let retryTickets = 0
    const retryClient = createGscdumpRealtimeV1Client({
      runtime: retryRuntime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '0' }),
      ticketProvider: () => ticket(retryRuntime, '0', ++retryTickets),
      applyEvent: async () => {},
      resync: async () => {},
    })
    await retryClient.start()
    const retrySocket = retryRuntime.sockets[0]!
    retrySocket.open()
    retrySocket.message({
      type: 'error',
      error: { code: 'overloaded', message: 'try later', retryable: true, retryAfter: 2 },
    })
    await settle()
    await retryRuntime.advance(1_999)
    expect(retryTickets).toBe(1)
    await retryRuntime.advance(1)
    expect(retryTickets).toBe(2)
  })

  it('treats protocol contradictions as terminal even when the server marks them retryable', async () => {
    const runtime = new FakeRuntime()
    let ticketCalls = 0
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '0' }),
      ticketProvider: () => ticket(runtime, '0', ++ticketCalls),
      applyEvent: async () => {},
      resync: async () => {},
    })

    await client.start()
    const socket = runtime.sockets[0]!
    socket.open()
    socket.message({
      type: 'error',
      error: {
        code: 'protocol_mismatch',
        message: 'upgrade the SDK',
        retryable: true,
      },
    })
    await settle()
    await runtime.advance(60_000)

    expect(ticketCalls).toBe(1)
    expect(client.getSnapshot()).toMatchObject({
      transport: 'terminal',
      error: { code: 'protocol_error', retryable: false, terminal: true },
    })
  })

  it('reports opaque pre-acceptance failures and escalates equal-jitter backoff with fresh tickets', async () => {
    const runtime = new FakeRuntime()
    let ticketCalls = 0
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '0' }),
      ticketProvider: () => ticket(runtime, '0', ++ticketCalls),
      applyEvent: async () => {},
      resync: async () => {},
    })

    await client.start()
    runtime.sockets[0]!.error()
    expect(client.getSnapshot()).toMatchObject({
      transport: 'waiting',
      error: { code: 'upgrade_rejected' },
    })
    await runtime.advance(499)
    expect(ticketCalls).toBe(1)
    await runtime.advance(1)
    expect(ticketCalls).toBe(2)
    expect(runtime.sockets[1]!.protocols[1]).toBe('gscdump.ticket.v1.payload2.signature2')

    runtime.sockets[1]!.error()
    await runtime.advance(999)
    expect(ticketCalls).toBe(2)
    await runtime.advance(1)
    expect(ticketCalls).toBe(3)
  })

  it.each([1006, 1011, 1013])('reconnects accepted sockets after retryable close %i', async (code) => {
    const runtime = new FakeRuntime()
    let ticketCalls = 0
    const client = createGscdumpRealtimeV1Client({
      runtime,
      cursorStore: new MemoryCursorStore({ streamId: STREAM, sequence: '0' }),
      ticketProvider: () => ticket(runtime, '0', ++ticketCalls),
      applyEvent: async () => {},
      resync: async () => {},
    })
    await client.start()
    runtime.sockets[0]!.open()
    runtime.sockets[0]!.serverClose(code)
    await runtime.advance(500)
    expect(ticketCalls).toBe(2)
  })

  it('rejects malformed ticket responses before constructing a socket', async () => {
    const runtime = new FakeRuntime()
    const client = createGscdumpRealtimeV1Client({
      runtime,
      ticketProvider: () => ({ ticket: 'not-an-envelope' }),
      applyEvent: async () => {},
      resync: async () => {},
    })

    await client.start()
    expect(runtime.sockets).toEqual([])
    expect(client.getSnapshot()).toMatchObject({
      transport: 'terminal',
      error: { code: 'ticket_invalid' },
    })
  })
})
