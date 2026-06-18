import { createPartnerRealtimeClient } from '../src'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readyState = 1
  sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null

  constructor(public url: string, public protocols?: string | string[]) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.onclose?.({ code: 1000 })
  }
}

describe('createPartnerRealtimeClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
  })

  it('authenticates on open and subscribes after connected', () => {
    const events: unknown[] = []
    const statuses: string[] = []
    const client = createPartnerRealtimeClient({
      apiBase: 'https://origin.example/api',
      apiKey: 'gsd_partner_1',
      siteIds: ['s_1'],
      WebSocket: FakeWebSocket,
    })
    client.onStatus(status => statuses.push(status))
    client.onEvent(event => events.push(event))

    const socket = client.connect() as FakeWebSocket
    expect(socket.url).toBe('wss://origin.example/ws/partner')

    socket.onopen?.({})
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'auth', apiKey: 'gsd_partner_1' })

    socket.onmessage?.({ data: JSON.stringify({ event: 'connected', partnerId: 'p_1', message: 'ok' }) })
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: 'subscribe', siteIds: ['s_1'] })
    expect(statuses).toContain('authenticated')

    socket.onmessage?.({ data: JSON.stringify({ event: 'sync.progress', siteId: 's_1', siteUrl: 'https://example.com', table: 'pages', date: '2026-05-11', progress: 0.5 }) })
    expect(events).toHaveLength(1)
  })

  function makeTimerHarness() {
    const timers: { fn: () => void, ms: number }[] = []
    return {
      setTimeout: (fn: () => void, ms: number) => {
        timers.push({ fn, ms })
        return timers.length - 1
      },
      clearTimeout: (handle: unknown) => {
        const i = handle as number
        if (timers[i])
          timers[i] = { fn: () => {}, ms: 0 }
      },
      runNext: () => {
        const next = timers.shift()
        next?.fn()
      },
      get pending() {
        return timers.filter(t => t.ms > 0).length
      },
      get delays() {
        return timers.map(t => t.ms)
      },
    }
  }

  it('reconnects after an unexpected close with exponential backoff', () => {
    const timer = makeTimerHarness()
    const client = createPartnerRealtimeClient({
      wsBase: 'wss://stream.example',
      scope: 'user',
      apiKey: 'gsd_partner_1',
      userId: 7,
      reconnect: { jitter: false },
      WebSocket: FakeWebSocket,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })

    client.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Simulate a network drop (not a caller-initiated close).
    FakeWebSocket.instances[0]!.onclose?.({ code: 1006 })
    expect(timer.pending).toBe(1)
    expect(timer.delays[0]).toBe(1000) // baseDelayMs * 2**0

    // Fire the reconnect timer → a fresh socket is opened.
    timer.runNext()
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Drop again → delay doubles.
    FakeWebSocket.instances[1]!.onclose?.({ code: 1006 })
    expect(timer.delays.at(-1)).toBe(2000)
  })

  it('resets backoff once a reconnection re-authenticates', () => {
    const timer = makeTimerHarness()
    const client = createPartnerRealtimeClient({
      wsBase: 'wss://stream.example',
      scope: 'user',
      apiKey: 'gsd_partner_1',
      userId: 7,
      reconnect: { jitter: false },
      WebSocket: FakeWebSocket,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })

    client.connect()
    FakeWebSocket.instances[0]!.onclose?.({ code: 1006 })
    timer.runNext()
    // Reconnected socket authenticates.
    FakeWebSocket.instances[1]!.onmessage?.({ data: JSON.stringify({ event: 'connected', message: 'ok' }) })
    // Next drop starts the backoff over at baseDelayMs.
    FakeWebSocket.instances[1]!.onclose?.({ code: 1006 })
    expect(timer.delays.at(-1)).toBe(1000)
  })

  it('does not reconnect after a caller-initiated close', () => {
    const timer = makeTimerHarness()
    const client = createPartnerRealtimeClient({
      wsBase: 'wss://stream.example',
      scope: 'user',
      apiKey: 'gsd_partner_1',
      userId: 7,
      WebSocket: FakeWebSocket,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })

    client.connect()
    client.close() // FakeWebSocket.close triggers onclose synchronously
    expect(timer.pending).toBe(0)
    expect(client.status).toBe('closed')
  })

  it('surfaces a real Error to onError once retries are exhausted', () => {
    const timer = makeTimerHarness()
    const errors: unknown[] = []
    const client = createPartnerRealtimeClient({
      wsBase: 'wss://stream.example',
      scope: 'user',
      apiKey: 'gsd_partner_1',
      userId: 7,
      reconnect: { maxRetries: 1, jitter: false },
      WebSocket: FakeWebSocket,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })
    client.onError(err => errors.push(err))

    client.connect()
    FakeWebSocket.instances[0]!.onclose?.({ code: 1006 }) // attempt 1 scheduled
    timer.runNext()
    FakeWebSocket.instances[1]!.onclose?.({ code: 1006 }) // exhausted → Error
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toContain('exhausted')
  })

  it('never reconnects when reconnect is disabled', () => {
    const timer = makeTimerHarness()
    const client = createPartnerRealtimeClient({
      wsBase: 'wss://stream.example',
      scope: 'user',
      apiKey: 'gsd_partner_1',
      userId: 7,
      reconnect: false,
      WebSocket: FakeWebSocket,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })

    client.connect()
    FakeWebSocket.instances[0]!.onclose?.({ code: 1006 })
    expect(timer.pending).toBe(0)
  })

  it('supports user websocket auth with injected base', () => {
    const client = createPartnerRealtimeClient({
      wsBase: 'wss://stream.example',
      scope: 'user',
      apiKey: 'gsd_partner_1',
      userId: 123,
      WebSocket: FakeWebSocket,
    })
    const socket = client.connect() as FakeWebSocket

    expect(socket.url).toBe('wss://stream.example/ws/user')
    socket.onopen?.({})
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'auth', apiKey: 'gsd_partner_1', userId: 123 })
  })
})
