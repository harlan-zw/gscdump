import { createRequire } from 'node:module'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { icebergManifests } from 'icebird/src/manifest.js'
import { describe, expect, it, vi } from 'vitest'
import { compressed, container, encode, entrySchema, fixture, limits, record, snapshotId, zig } from './bounded-avro-fixtures'

const icebirdRequire = createRequire(import.meta.resolve('icebird'))
const { gunzip } = await import(icebirdRequire.resolve('hyparquet-compressors'))

describe('opt-in actual Avro manifest read limits', () => {
  it.each([false, true])('keeps exact ordered manifests, inheritance and bigint values (deflate: %s)', async (deflate) => {
    const f = fixture(8, 16, deflate)
    const input = { metadata: f.metadata, resolver: f.resolver }
    const normal = await icebergManifests(input)
    f.reads.length = 0
    expect(await icebergManifests({ ...input, readLimits: limits })).toEqual(normal)
    expect(f.reads).toHaveLength(9)
    expect(f.reads.reduce((n, r) => n + r.bytes, 0)).toBe([...f.objects.values()].reduce((n, b) => n + b.byteLength, 0))
  })

  it('admits source bytes before slice and reserves aggregate bytes across concurrent manifest reads', async () => {
    const f = fixture()
    await expect(icebergManifests({ ...f, readLimits: { ...limits, maxObjectBytes: 16 } })).rejects.toThrow('objectBytes')
    expect(f.reads).toHaveLength(0)
    const list = f.objects.get('memory://list')!.byteLength
    const first = f.objects.get('memory://manifest-0')!.byteLength
    await expect(icebergManifests({ ...f, readLimits: { ...limits, maxTotalObjectBytes: list + first } })).rejects.toThrow('objectBytes')
    expect(f.reads.map(r => r.path)).toEqual(['memory://list', 'memory://manifest-0'])
  })

  it('refuses the ninth manifest before fanout even when pruning returns false', async () => {
    const f = fixture(9, 1)
    await expect(icebergManifests({ ...f, partitionFilter: () => false, readLimits: limits })).rejects.toThrow('manifests')
    expect(f.reads.map(r => r.path)).toEqual(['memory://list'])
  })

  it('counts entries across manifests and blocks, outside caught pruning callbacks', async () => {
    const f = fixture(3, 43)
    await expect(icebergManifests({ ...f, partitionFilter: () => {
      throw new Error('optional pruning failed')
    }, readLimits: limits })).rejects.toThrow('entries')
  })

  it('bounds small-wire null array amplification before looping over declared items', async () => {
    const f = fixture(0)
    f.objects.set('memory://list', container({ type: 'record', name: 'r', fields: [{ name: 'x', type: { type: 'array', items: 'null' } }] }, [
      { count: 1, bytes: Uint8Array.from([...zig(10_000), 0]) },
    ]))
    await expect(icebergManifests({ ...f, readLimits: { ...limits, maxDecodedValues: 500 } })).rejects.toThrow('values')
    expect(f.objects.get('memory://list')!.byteLength).toBeLessThan(256)
  })

  it('bounds real compressed expansion before creating an oversized output buffer', async () => {
    const input = deflateRawSync(new Uint8Array(2 * 1024 * 1024).fill(65))
    const Original = Uint8Array
    const allocated: number[] = []
    const observed = new Proxy(Original, { construct(target, args) {
      if (typeof args[0] === 'number')
        allocated.push(args[0])
      return Reflect.construct(target, args)
    } })
    vi.stubGlobal('Uint8Array', observed)
    try {
      expect(() => gunzip(input, undefined, 0, 0, { raw: true, maxOutputBytes: 65536 })).toThrow('output byte limit')
    }
    finally { vi.unstubAllGlobals() }
    expect(Math.max(...allocated)).toBeLessThanOrEqual(65536)
    expect(gunzip(input)).toHaveLength(2 * 1024 * 1024)
  })

  it('propagates the inflated block policy through the actual manifest reader', async () => {
    const f = fixture(0)
    const raw = encode(entrySchema, [{ ...record(0), data_file: { ...record(0).data_file, file_path: 'x'.repeat(1024 * 1024) } }])
    f.objects.set('memory://list', compressed(raw))
    await expect(icebergManifests({ ...f, readLimits: { ...limits, maxInflatedBlockBytes: 65536 } })).rejects.toThrow('output byte limit')
    expect(f.objects.get('memory://list')!.byteLength).toBeLessThan(4096)
  })

  it('does not accept unqualified decoded cache or silently ignore unknown policy fields', async () => {
    const f = fixture()
    await expect(icebergManifests({ ...f, manifestCache: { lists: new Map(), entries: new Map() }, readLimits: limits })).rejects.toThrow('uncached')
    await expect(icebergManifests({ ...f, readLimits: { ...limits, typo: 1 } as typeof limits })).rejects.toThrow('Unknown')
    expect(f.reads).toHaveLength(0)
  })

  it('snapshots every limit before the first resolver await', async () => {
    const f = fixture(9, 1)
    const changed = { ...limits }
    const original = f.resolver.reader
    f.resolver.reader = (...args) => {
      changed.maxManifests = 999
      return original(...args)
    }
    await expect(icebergManifests({ ...f, readLimits: changed })).rejects.toThrow('manifests')
  })

  it('retains original transport errors and does not start later manifests after failure', async () => {
    const f = fixture(8, 1)
    const original = f.resolver.reader
    const error = new Error('owned transport failed')
    let calls = 0
    f.resolver.reader = (...args) => {
      calls++
      if (args[0] === 'memory://manifest-0')
        throw error
      return original(...args)
    }
    await expect(icebergManifests({ ...f, readLimits: limits })).rejects.toBe(error)
    expect(calls).toBe(2)
  })

  it('counts inline v1 manifests before reading, and decodes each admitted file once', async () => {
    const f = fixture(2, 3)
    f.metadata.snapshots = [{ 'snapshot-id': snapshotId, 'manifests': ['memory://manifest-0', 'memory://manifest-1'] }] as typeof f.metadata.snapshots
    const normal = await icebergManifests(f)
    expect(f.reads).toHaveLength(4)
    f.reads.length = 0
    expect(await icebergManifests({ ...f, readLimits: limits })).toEqual(normal)
    expect(f.reads).toHaveLength(2)
    f.reads.length = 0
    await expect(icebergManifests({ ...f, readLimits: { ...limits, maxManifests: 1 } })).rejects.toThrow('manifests')
    expect(f.reads).toHaveLength(0)
  })

  it('retains manifest inheritance and default caller-owned cache behavior', async () => {
    const f = fixture(1, 1)
    const raw = record(0)
    f.objects.set('memory://manifest-0', encode(entrySchema, [{ ...raw, snapshot_id: null, sequence_number: null, file_sequence_number: null }]))
    // Inline metadata obtains the new exact byte length from the real reader.
    f.metadata.snapshots = [{ 'snapshot-id': snapshotId, 'manifests': ['memory://manifest-0'] }] as typeof f.metadata.snapshots
    const normal = await icebergManifests(f)
    expect(normal[0]!.entries[0]!.snapshot_id).toBe(snapshotId)
    expect(await icebergManifests({ ...f, readLimits: limits })).toEqual(normal)
    const cached = fixture(1, 1)
    const manifestCache = { lists: new Map(), entries: new Map() }
    const first = await icebergManifests({ ...cached, manifestCache })
    cached.reads.length = 0
    expect(await icebergManifests({ ...cached, manifestCache })).toEqual(first)
    expect(cached.reads.map(r => r.path)).toEqual(['memory://manifest-0'])
  })

  it.each([
    ['negative value length', 'string', [...zig(-1)], 'valueBytes'],
    ['truncated value', 'string', [...zig(4), 65], 'encodedBytes'],
    ['oversized value', 'string', [...zig(1025), ...new Uint8Array(1025)], 'valueBytes'],
    ['invalid union', ['null', 'int'], [...zig(2)], 'unionIndex'],
    ['overlong varint', 'long', Array.from({ length: 11 }).fill(128), 'Invalid Avro long'],
    ['negative array block size', { type: 'array', items: 'null' }, [...zig(-2), ...zig(-1), 0], 'containerBlockBytes'],
    ['mismatched array block size', { type: 'array', items: 'null' }, [...zig(-2), ...zig(1), 0], 'block length mismatch'],
    ['mismatched map block size', { type: 'map', values: 'null' }, [...zig(-1), ...zig(1), ...zig(1), 65, 0], 'block length mismatch'],
  ])('refuses malformed or oversized %s in the actual parser', async (_name, type, bytes, message) => {
    const f = fixture(0)
    f.objects.set('memory://list', container({ type: 'record', name: 'r', fields: [{ name: 'x', type }] }, [{ count: 1, bytes: Uint8Array.from(bytes as number[]) }]))
    await expect(icebergManifests({ ...f, readLimits: { ...limits, maxValueBytes: 1024 } })).rejects.toThrow(message as string)
    expect(f.reads).toHaveLength(1)
  })

  it('accepts valid negative-count arrays/maps with exact declared block lengths', async () => {
    const f = fixture(0)
    const schema = { type: 'record', name: 'r', fields: [
      { name: 'a', type: { type: 'array', items: 'null' } },
      { name: 'm', type: { type: 'map', values: 'null' } },
    ] }
    f.objects.set('memory://list', container(schema, [{ count: 1, bytes: Uint8Array.from([
      ...zig(-2),
      ...zig(0),
      0,
      ...zig(-1),
      ...zig(2),
      ...zig(1),
      65,
      0,
    ]) }]))
    // The real parser succeeds before the existing conservative pruning hook.
    const seen: unknown[] = []
    expect(await icebergManifests({ ...f, readLimits: limits, partitionFilter: (_parts, _spec, row) => {
      seen.push(row)
      return false
    } })).toEqual([])
    expect(seen).toEqual([{ a: [undefined, undefined], m: { A: undefined } }])
  })

  it('bounds header bytes and schema depth before recursive compilation', async () => {
    const f = fixture(1)
    await expect(icebergManifests({ ...f, readLimits: { ...limits, maxHeaderBytes: 32 } })).rejects.toThrow()
    let nested: unknown = 'null'
    for (let i = 0; i < 40; i++) nested = { type: 'array', items: nested }
    f.objects.set('memory://list', container(nested, []))
    await expect(icebergManifests({ ...f, readLimits: limits })).rejects.toThrow('schemaDepth')
  })

  it('charges null and DEFLATE output cumulatively across blocks', async () => {
    for (const deflate of [false, true]) {
      const f = fixture(2, 16, deflate)
      await expect(icebergManifests({ ...f, readLimits: { ...limits, maxTotalInflatedBytes: 256 } })).rejects.toThrow(/inflatedBytes|output byte limit/)
    }
  })

  it('rejects mismatched source length hints and short returned slices', async () => {
    const f = fixture(1)
    const reader = f.resolver.reader
    f.resolver.reader = async (...args) => {
      const result = await reader(...args)
      return args[0] === 'memory://list' ? result : { ...result, byteLength: result.byteLength + 1 }
    }
    await expect(icebergManifests({ ...f, readLimits: limits })).rejects.toThrow('object length changed')
    expect(f.reads.map(r => r.path)).toEqual(['memory://list'])
    f.resolver.reader = async (...args) => {
      const result = await reader(...args)
      return { ...result, slice: async () => new ArrayBuffer(0) }
    }
    await expect(icebergManifests({ ...f, readLimits: limits })).rejects.toThrow('range length changed')
  })

  it.each([0, -1, 0.5, Number.NaN, Infinity])('rejects invalid limits (%s) before resolver work', async (value) => {
    const f = fixture(0)
    const reader = vi.spyOn(f.resolver, 'reader')
    await expect(icebergManifests({ ...f, readLimits: { ...limits, maxEntries: value } })).rejects.toThrow('Invalid')
    expect(reader).not.toHaveBeenCalled()
  })

  it('checks exact DEFLATE output boundaries for stored, fixed and dynamic blocks', () => {
    const bytes = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz'.repeat(200))
    for (const [type, options] of [[0, { level: 0 }], [1, { strategy: 4 }], [2, { level: 9 }]] as const) {
      const packed = deflateRawSync(bytes, options)
      expect((packed[0]! >> 1) & 3).toBe(type)
      expect(gunzip(packed, undefined, 0, 0, { raw: true, maxOutputBytes: bytes.byteLength })).toEqual(bytes)
      expect(() => gunzip(packed, undefined, 0, 0, { raw: true, maxOutputBytes: bytes.byteLength - 1 })).toThrow('output byte limit')
      const compact = gunzip(packed, undefined, 0, 0, { raw: true, maxOutputBytes: 65536 })
      expect(compact.buffer.byteLength).toBe(bytes.byteLength)
    }
    const empty = deflateRawSync(new Uint8Array(0))
    expect(gunzip(empty, undefined, 0, 0, { raw: true, maxOutputBytes: 0 })).toHaveLength(0)
    expect(() => gunzip(Uint8Array.of(1, 0, 0, 0, 0), undefined, 0, 0, { raw: true, maxOutputBytes: 1024 })).toThrow('stored block length')
    expect(() => gunzip(Uint8Array.from([...empty, 0]), undefined, 0, 0, { raw: true, maxOutputBytes: 1024 })).toThrow('trailing')
    const invalidBackreference = Uint8Array.of(3, 2, 0)
    expect(() => inflateRawSync(invalidBackreference)).toThrow()
    expect(() => gunzip(invalidBackreference, undefined, 0, 0, { raw: true, maxOutputBytes: 1024 })).toThrow('dictionary')
    const invalidDistanceSymbol = Uint8Array.of(3, 62, 0)
    expect(() => inflateRawSync(invalidDistanceSymbol)).toThrow()
    expect(() => gunzip(invalidDistanceSymbol, undefined, 0, 0, { raw: true, maxOutputBytes: 1024 })).toThrow('distance')
  })
})
