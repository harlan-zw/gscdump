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
