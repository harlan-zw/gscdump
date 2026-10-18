import { createHash, webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveAppendIdentity } from '../src/append-identity'

// Frozen reference from 1045b397: compare bytes, not a second streamed encoder.
function encodeValue(value: unknown): unknown {
  if (value === null)
    return 'null'
  if (typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol')
      throw new TypeError('Append records contain an unsupported value.')
    return `${typeof value}:${Object.is(value, -0) ? '-0' : String(value)}`
  }
  if (value instanceof Date)
    return `date:${value.toISOString()}`
  if (value instanceof Uint8Array)
    return `bytes:${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`
  if (Array.isArray(value))
    return ['array', Array.from(value, encodeValue)]
  if (value instanceof Map) {
    const entries = Array.from(value, ([key, entry]) => JSON.stringify([encodeValue(key), encodeValue(entry)])).sort()
    return ['map', entries]
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new TypeError('Append records contain an unsupported value.')
  return ['object', Object.keys(value).sort().map(key => [key, encodeValue((value as Record<string, unknown>)[key])])]
}

async function reference(records: Record<string, unknown>[]) {
  const hash = async (value: string) => Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
  const legacyAppendId = await hash(records.map(record => Object.keys(record).sort().map(key => `${key}=${String(record[key])}`).join('')).sort().join(''))
  const groups = new Map<string, string[]>()
  for (const record of records) {
    if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)
      throw new TypeError('Append records contain an unsupported value.')
    const keys = Object.keys(record).sort()
    const schema = JSON.stringify(keys)
    const row = JSON.stringify(keys.map(key => encodeValue(record[key])))
    const group = groups.get(schema)
    if (group)
      group.push(row)
    else
      groups.set(schema, [row])
  }
  const content = `[${Array.from(groups, ([schema, rows]) => `[${schema},[${rows.sort().join(',')}]]`).sort().join(',')}]`
  return { _tag: 'Content', appendId: `content-v2:${await hash(content)}`, legacyAppendId }
}

const NativeTextEncoderStream = globalThis.TextEncoderStream
interface StreamStats { writes: number, maxBytes: number, closed: boolean, aborted: boolean }

function installStreams(failure?: 'write' | 'close' | 'digest') {
  const streams: StreamStats[] = []
  const text = { writes: 0, maxUnits: 0, pending: 0, maxPending: 0, releases: 0 }
  const error = new Error(`fixture ${failure} failed`)
  const digest = vi.fn(webcrypto.subtle.digest.bind(webcrypto.subtle))
  class DigestStream extends WritableStream<Uint8Array<ArrayBuffer>> {
    readonly digest: Promise<ArrayBuffer>
    constructor(algorithm: string) {
      expect(algorithm).toBe('SHA-256')
      let resolve!: (value: ArrayBuffer) => void
      let reject!: (reason: unknown) => void
      const result = new Promise<ArrayBuffer>((yes, no) => {
        resolve = yes
        reject = no
      })
      const hash = createHash('sha256')
      const stats: StreamStats = { writes: 0, maxBytes: 0, closed: false, aborted: false }
      super({
        async write(chunk) {
          stats.writes++
          stats.maxBytes = Math.max(stats.maxBytes, chunk.byteLength)
          await Promise.resolve()
          if (failure === 'write') {
            reject(error)
            throw error
          }
          hash.update(chunk)
        },
        close() {
          stats.closed = true
          if (failure === 'close' || failure === 'digest') {
            reject(error)
            if (failure === 'close')
              throw error
            return
          }
          resolve(Uint8Array.from(hash.digest()).buffer)
        },
        abort(reason) {
          stats.aborted = true
          reject(reason)
        },
      })
      this.digest = result
      streams.push(stats)
    }
  }
  class ObservedTextEncoderStream extends NativeTextEncoderStream {
    constructor() {
      super()
      const getWriter = this.writable.getWriter.bind(this.writable)
      this.writable.getWriter = () => {
        const writer = getWriter()
        const write = writer.write.bind(writer)
        writer.write = async (chunk) => {
          text.writes++
          text.maxUnits = Math.max(text.maxUnits, chunk.length)
          text.pending++
          text.maxPending = Math.max(text.maxPending, text.pending)
          try {
            return await write(chunk)
          }
          finally {
            text.pending--
          }
        }
        const release = writer.releaseLock.bind(writer)
        writer.releaseLock = () => {
          text.releases++
          release()
        }
        return writer
      }
    }
  }
  vi.stubGlobal('crypto', { DigestStream, subtle: { digest }, randomUUID: webcrypto.randomUUID.bind(webcrypto) })
  vi.stubGlobal('TextEncoderStream', ObservedTextEncoderStream)
  return { streams, text, digest, error }
}

function fixtures(): Array<[string, Record<string, unknown>[]]> {
  return [
    ['empty records', [{}, {}, { a: 1 }]],
    ['primitive values', [{ nil: null, missing: undefined, zero: 0, negativeZero: -0, nan: NaN, inf: Infinity, minusInf: -Infinity, yes: true, no: false, bigint: 12345678901234567890n, text: '1' }]],
    ['nested values', [{ nested: { z: [undefined, null, -0, 7n], a: { q: '雪😀', r: 'x' } }, date: new Date('2026-10-18T00:00:00Z'), bytes: new Uint8Array([0, 1, 127, 128, 255]), map: new Map([[{ b: 2, a: 1 }, ['x', 1]], ['x', null]]) }, Object.assign(Object.create(null), { z: 1, a: 'null-prototype' })]],
    ['heterogeneous schemas', [{}, { a: 1 }, { a: 1, b: 2 }, { aa: 3 }, { a: null, c: 'x' }, { 'a"': 1 }, { ']': 2 }, { '\\': 3 }, { ',': 4 }, { '': 5 }, { '\uD800': 6 }, { '\uDC00': 7 }]],
    ['Unicode', [{ 'a': '雪é😀e\u0301\u0000\r\n\uD800x\uDC00', '\uD800': '\uDC00' }, { x: '𝄞' }]],
    ['cross-row legacy surrogate pair', [{ a: '\uD83D' }, { '\uDE00': 'tail' }]],
    ['typed legacy collisions', [{ a: 'x', b: 'yb=z' }, { a: 'xb=y', b: 'z' }, { a: 1 }, { a: '1' }, { a: null }, { a: 'null' }, { a: -0 }, { a: 0 }]],
    ['numeric keys', [{ '10': 'ten', '2': 'two', '01': 'one', 'a': 1 }]],
  ]
}

afterEach(() => vi.unstubAllGlobals())

describe('streamed append identities', () => {
  it.each(fixtures())('preserves exact legacy and content-v2 digests: %s', async (_, rows) => {
    const { streams, digest, text } = installStreams()
    const expected = await reference(rows)
    expect(await deriveAppendIdentity(rows)).toEqual(expected)
    expect(streams).toHaveLength(2)
    expect(streams.every(stream => stream.closed)).toBe(true)
    expect(digest).not.toHaveBeenCalled()
    expect(text.releases).toBe(2)
    const reordered = rows.slice().reverse().map(row => Object.fromEntries(Object.entries(row).reverse()))
    expect(await deriveAppendIdentity(reordered)).toEqual(expected)
  })

  it('preserves schema group order without joining the complete group strings', async () => {
    const { streams } = installStreams()
    const keys = ['', 'a', 'aa', 'a"', ']', ',', '\uD800', '\uDC00']
    const rows = Array.from({ length: 256 }, (_, mask) => Object.fromEntries(keys.filter((_, bit) => mask & (1 << bit)).map((key, i) => [key, `value-${i}-${mask}`])))
    expect(await deriveAppendIdentity(rows)).toEqual(await reference(rows))
    expect(streams).toHaveLength(2)
  })

  it('coalesces many short rows into bounded writes with backpressure', async () => {
    const { streams, text, digest } = installStreams()
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ query: `q-${i}`, date: 20744, clicks: i % 17, text: i % 3 ? 'ascii' : '雪😀' }))
    expect(await deriveAppendIdentity(rows)).toEqual(await reference(rows))
    expect(streams).toHaveLength(2)
    expect(text.writes).toBeGreaterThan(2)
    expect(text.writes).toBeLessThan(100)
    expect(text.maxUnits).toBeLessThanOrEqual(65_536)
    expect(streams.every(stream => stream.maxBytes <= 3 * 65_536 + 4)).toBe(true)
    expect(text.maxPending).toBe(1)
    expect(text.pending).toBe(0)
    expect(text.releases).toBe(2)
    expect(digest).not.toHaveBeenCalled()
  })

  it.each([65_520, 65_529, 65_530, 65_535])('preserves split surrogate pairs and final unpaired surrogates at padding %i', async (padding) => {
    const { text } = installStreams()
    const rows = [{ query: `${'x'.repeat(padding)}😀${'雪'.repeat(65_536)}\uD800`, extra: '\uDC00' }]
    expect(await deriveAppendIdentity(rows)).toEqual(await reference(rows))
    expect(text.writes).toBeGreaterThan(2)
    expect(text.maxUnits).toBeLessThanOrEqual(65_536)
  })

  it('keeps row multiplicity and legacy collision evidence', async () => {
    installStreams()
    expect((await deriveAppendIdentity([{}])).appendId).not.toBe((await deriveAppendIdentity([{}, {}])).appendId)
    const first = await deriveAppendIdentity([{ a: 'x', b: 'yb=z' }])
    const second = await deriveAppendIdentity([{ a: 'xb=y', b: 'z' }])
    expect(first).toMatchObject({ _tag: 'Content' })
    expect(second).toMatchObject({ _tag: 'Content' })
    if (first._tag === 'Content' && second._tag === 'Content') {
      expect(first.legacyAppendId).toBe(second.legacyAppendId)
      expect(first.appendId).not.toBe(second.appendId)
    }
  })

  it.each(['DigestStream', 'TextEncoderStream'] as const)('keeps the original one-shot path when %s is absent', async (missing) => {
    const { streams, digest } = installStreams()
    if (missing === 'DigestStream')
      vi.stubGlobal('crypto', { subtle: { digest }, randomUUID: webcrypto.randomUUID.bind(webcrypto) })
    else
      vi.stubGlobal('TextEncoderStream', undefined)
    const rows = fixtures()[2]![1]
    expect(await deriveAppendIdentity(rows)).toEqual(await reference(rows))
    expect(streams).toHaveLength(0)
    expect(digest).toHaveBeenCalledTimes(2)
  })

  it('retains random explicit identity and no hashing for empty input', async () => {
    const { streams, digest } = installStreams()
    const a = await deriveAppendIdentity([])
    const b = await deriveAppendIdentity([])
    expect(a).toMatchObject({ _tag: 'Explicit' })
    expect(a.appendId).not.toBe(b.appendId)
    expect(streams).toHaveLength(0)
    expect(digest).not.toHaveBeenCalled()
  })

  it.each(['write', 'close', 'digest'] as const)('propagates %s failure, settles writes and releases the lock without fallback', async (failure) => {
    const { streams, text, digest, error } = installStreams(failure)
    await expect(deriveAppendIdentity([{ query: 'x'.repeat(200_000) }])).rejects.toBe(error)
    expect(streams).toHaveLength(1)
    expect(text.pending).toBe(0)
    expect(text.releases).toBe(1)
    expect(digest).not.toHaveBeenCalled()
  })

  it('propagates a serialization failure before opening any stream', async () => {
    const { streams, digest } = installStreams()
    const failure = new Error('getter failed')
    const row = Object.defineProperty({}, 'query', {
      enumerable: true,
      get() { throw failure },
    })
    await expect(deriveAppendIdentity([row])).rejects.toBe(failure)
    expect(streams).toHaveLength(0)
    expect(digest).not.toHaveBeenCalled()
  })

  it.each([
    ['function', { a() {} }],
    ['symbol', { a: Symbol('x') }],
    ['invalid date', { a: new Date(NaN) }],
    ['nested unsupported object', { a: new Set([1]) }],
  ])('preserves %s refusal after the completed legacy digest', async (_, row) => {
    const { streams, digest, text } = installStreams()
    const expected = await reference([row]).catch(error => error)
    await expect(deriveAppendIdentity([row])).rejects.toThrow(expected.message)
    expect(streams).toHaveLength(1)
    expect(streams[0]!.closed).toBe(true)
    expect(text.releases).toBe(1)
    expect(digest).not.toHaveBeenCalled()
  })
})
