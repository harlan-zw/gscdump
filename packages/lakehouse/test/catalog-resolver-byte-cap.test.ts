import { beforeEach, describe, expect, it, vi } from 'vitest'

const { s3SignedResolver } = vi.hoisted(() => ({ s3SignedResolver: vi.fn() }))
vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect: vi.fn(async ({ url }: { url: string }) => ({ type: 'rest', url, prefix: '', defaults: {}, overrides: {} })), restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable: vi.fn() }))
vi.mock('icebird/src/s3.js', () => ({ s3SignedResolver }))
const { connectIcebergCatalog } = await import('../src/catalog')

const MiB = 1024 * 1024
// The default connection cache cap. A test that fills past it proves the cap holds.
const cap = 16 * MiB

interface Store {
  objects: Map<string, ArrayBuffer>
  /** Paths whose next reader call throws. */
  failReader: Set<string>
  /** Paths whose next slice call rejects. */
  failSlice: Set<string>
  readerCalls: string[]
  fetchedBytes: Map<string, number>
}

function store(): Store {
  return { objects: new Map(), failReader: new Set(), failSlice: new Set(), readerCalls: [], fetchedBytes: new Map() }
}

async function connect(s: Store) {
  s3SignedResolver.mockReturnValue({
    reader(path: string) {
      s.readerCalls.push(path)
      if (s.failReader.delete(path))
        return Promise.reject(new Error(`503 ${path}`))
      const bytes = s.objects.get(path)
      if (!bytes)
        return Promise.reject(new Error(`404 ${path}`))
      return {
        byteLength: bytes.byteLength,
        async slice(start: number, end?: number) {
          if (s.failSlice.delete(path))
            throw new Error(`reset ${path}`)
          const out = bytes.slice(start, end)
          s.fetchedBytes.set(path, (s.fetchedBytes.get(path) ?? 0) + out.byteLength)
          return out
        },
      }
    },
    writer: () => ({ offset: 0, finish: async () => {} }),
  })
  return connectIcebergCatalog({
    catalogUri: 'https://catalog.invalid',
    warehouse: 'synthetic',
    namespace: 'gsc',
    catalogToken: 'test',
    s3: { endpoint: 'https://s3.invalid', accessKeyId: 'test', secretAccessKey: 'test' },
  })
}

type Connection = Awaited<ReturnType<typeof connect>>

async function readWhole(conn: Connection, path: string): Promise<ArrayBuffer> {
  const file = await conn.resolver.reader(path)
  return file.slice(0, file.byteLength)
}

/** Read `path` and report whether the connection served it without a new S3 fetch. */
async function servedFromCache(conn: Connection, s: Store, path: string): Promise<boolean> {
  const before = s.fetchedBytes.get(path) ?? 0
  await readWhole(conn, path)
  return (s.fetchedBytes.get(path) ?? 0) === before
}

function put(s: Store, path: string, bytes: number): void {
  s.objects.set(path, new Uint8Array(bytes).fill(path.length).buffer)
}

describe('connection resolver byte cap', () => {
  beforeEach(() => {
    s3SignedResolver.mockReset()
  })

  it('keeps at most the cap of object bytes after many reads', async () => {
    const s = store()
    const paths = Array.from({ length: 5 }, (_, i) => `s3://b/manifest-${i}.avro`)
    for (const path of paths)
      put(s, path, 6 * MiB)
    const conn = await connect(s)
    for (const path of paths)
      await readWhole(conn, path)
    // Most recent first: a cached object is served before a miss can evict it.
    let retained = 0
    for (const path of paths.toReversed()) {
      if (await servedFromCache(conn, s, path))
        retained += s.objects.get(path)!.byteLength
    }
    expect(retained).toBeGreaterThan(0)
    expect(retained).toBeLessThanOrEqual(cap)
  })

  it('evicts the least recently used object first', async () => {
    const s = store()
    for (const path of ['a', 'b', 'c'])
      put(s, path, 6 * MiB)
    const conn = await connect(s)
    await readWhole(conn, 'a')
    await readWhole(conn, 'b')
    expect(await servedFromCache(conn, s, 'a')).toBe(true)
    await readWhole(conn, 'c')
    expect(await servedFromCache(conn, s, 'a')).toBe(true)
    expect(await servedFromCache(conn, s, 'b')).toBe(false)
  })

  it('does not cache an object larger than the cap, and keeps the others', async () => {
    const s = store()
    put(s, 'small', 1024)
    put(s, 'huge', cap + 1)
    const conn = await connect(s)
    await readWhole(conn, 'small')
    await readWhole(conn, 'huge')
    expect(await servedFromCache(conn, s, 'huge')).toBe(false)
    expect(await servedFromCache(conn, s, 'small')).toBe(true)
  })

  it('shares one S3 reader call between concurrent reads of one path', async () => {
    const s = store()
    put(s, 'meta', 2048)
    const conn = await connect(s)
    const [x, y] = await Promise.all([readWhole(conn, 'meta'), readWhole(conn, 'meta')])
    expect(x.byteLength).toBe(2048)
    expect(y.byteLength).toBe(2048)
    expect(s.readerCalls).toEqual(['meta'])
  })

  it('does not cache a failed reader call', async () => {
    const s = store()
    put(s, 'meta', 2048)
    s.failReader.add('meta')
    const conn = await connect(s)
    await expect(readWhole(conn, 'meta')).rejects.toThrow('503')
    expect((await readWhole(conn, 'meta')).byteLength).toBe(2048)
    expect(s.readerCalls).toEqual(['meta', 'meta'])
  })

  it('does not cache a failed range read', async () => {
    const s = store()
    put(s, 'big', 2 * MiB)
    s.failSlice.add('big')
    const conn = await connect(s)
    await expect(readWhole(conn, 'big')).rejects.toThrow('reset')
    expect((await readWhole(conn, 'big')).byteLength).toBe(2 * MiB)
  })

  it('reads a path again after a successful write to it', async () => {
    const s = store()
    put(s, 'hint', 16)
    const conn = await connect(s)
    await readWhole(conn, 'hint')
    await conn.resolver.writer!('hint').finish()
    expect(await servedFromCache(conn, s, 'hint')).toBe(false)
  })
})
