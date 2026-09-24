import type { TableMetadata } from 'icebird'
import { parquetReadObjects } from 'hyparquet'
import { icebergManifests, s3SignedResolver } from 'icebird'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { icebergAppendBatchesRetrying, icebergAppendRetrying } from '../src/catalog'

function localCatalog(conflictStatus: 409 | 412, concurrent = true, ambiguous = false) {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>()
  let metadata: TableMetadata = {
    'format-version': 2,
    'table-uuid': '00000000-0000-4000-8000-000000000001',
    'location': 's3://local/table',
    'last-sequence-number': 0,
    'last-updated-ms': 1,
    'last-column-id': 1,
    'current-schema-id': 0,
    'schemas': [{ 'type': 'struct', 'schema-id': 0, 'fields': [{ id: 1, name: 'url', required: true, type: 'string' }] }],
    'default-spec-id': 0,
    'partition-specs': [{ 'spec-id': 0, 'fields': [] }],
    'last-partition-id': 999,
    'default-sort-order-id': 0,
    'sort-orders': [{ 'order-id': 0, 'fields': [] }],
    'properties': { 'commit.retry.min-wait-ms': '0', 'commit.retry.max-wait-ms': '0', 'write.parquet.compression-codec': 'uncompressed' },
    'snapshots': [],
    'refs': {},
  }
  let loads = 0
  let commits = 0
  let conflicts = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    expect(['catalog.invalid', 'objects.invalid']).toContain(url.hostname)
    if (url.hostname === 'objects.invalid') {
      if (method === 'PUT') {
        objects.set(url.pathname, new Uint8Array(init.body as Uint8Array<ArrayBuffer>))
        return new Response(null)
      }
      const bytes = objects.get(url.pathname)
      if (!bytes)
        throw new Error(`Missing local object: ${url.pathname}`)
      if (method === 'HEAD')
        return new Response(null, { headers: { 'content-length': String(bytes.length) } })
      expect(method).toBe('GET')
      const range = new Headers(init.headers).get('range')?.match(/bytes=(\d+)-(\d+)/)
      return new Response(range ? bytes.slice(Number(range[1]), Number(range[2]) + 1) : bytes)
    }
    if (method === 'GET') {
      loads++
      const response = Response.json({ metadata })
      if (concurrent && loads <= 2) {
        if (loads === 2)
          release()
        await gate
      }
      return response
    }
    expect(method).toBe('POST')
    const body = JSON.parse(String(init.body)) as {
      requirements: { 'type': string, 'snapshot-id': number | null }[]
      updates: { action: string, snapshot: NonNullable<TableMetadata['snapshots']>[number] }[]
    }
    const expected = body.requirements.find(r => r.type === 'assert-ref-snapshot-id')!['snapshot-id']
    if (expected !== (metadata['current-snapshot-id'] ?? null)) {
      conflicts++
      return Response.json({ error: { message: 'Snapshot conflict', code: conflictStatus } }, { status: conflictStatus })
    }
    const snapshot = body.updates.find(u => u.action === 'add-snapshot')!.snapshot
    metadata = { ...metadata, 'current-snapshot-id': snapshot['snapshot-id'], 'last-sequence-number': snapshot['sequence-number']!, 'snapshots': [...metadata.snapshots!, snapshot] }
    commits++
    if (ambiguous && commits === 1)
      return Response.json({ error: { message: 'Lost commit response', code: 503 } }, { status: 503 })
    return Response.json({ metadata })
  })
  const resolver = s3SignedResolver({ accessKeyId: 'local', secretAccessKey: 'local', region: 'auto', endpoint: 'https://objects.invalid', pathStyle: true })
  const target = { catalog: { type: 'rest' as const, url: 'https://catalog.invalid', prefix: '', defaults: {}, overrides: {} }, namespace: 'gsc', table: 'pages', resolver }
  return {
    target,
    conflicts: () => conflicts,
    tokens: () => metadata.snapshots!.map(s => s.summary!['lakehouse.append-id']),
    async rows() {
      const manifests = await icebergManifests({ metadata, resolver })
      const rows = []
      for (const manifest of manifests) {
        for (const entry of manifest.entries) {
          if (entry.status !== 2)
            rows.push(...await parquetReadObjects({ file: await resolver.reader(entry.data_file.file_path) }))
        }
      }
      return rows.sort((a, b) => String(a.url).localeCompare(String(b.url)))
    },
  }
}

const fast = { sleep: async () => {}, random: () => 0 }
afterEach(() => vi.unstubAllGlobals())

for (const mode of ['rows', 'batches'] as const) {
  describe(`${mode} append idempotency`, () => {
    function append(local: ReturnType<typeof localCatalog>, token: string, url = '/') {
      return mode === 'rows'
        ? icebergAppendRetrying({ ...local.target, records: [{ url }] }, { ...fast, appendId: token })
        : icebergAppendBatchesRetrying({ ...local.target, batchFactory: () => [[{ url }]] }, { ...fast, appendId: token })
    }

    it.each([409, 412] as const)('commits concurrent identical tokens once after HTTP %i', async (status) => {
      const local = localCatalog(status)
      await Promise.all([append(local, 'same'), append(local, 'same')])
      expect(local.conflicts()).toBe(1)
      expect(local.tokens()).toEqual(['same'])
      expect(await local.rows()).toEqual([{ url: '/' }])
    })

    it('keeps both concurrent appends when tokens differ', async () => {
      const local = localCatalog(409)
      await Promise.all([append(local, 'a', '/a'), append(local, 'b', '/b')])
      expect(local.conflicts()).toBe(1)
      expect(local.tokens().sort()).toEqual(['a', 'b'])
      expect(await local.rows()).toEqual([{ url: '/a' }, { url: '/b' }])
    })

    it('does not repeat a committed append after HTTP 503', async () => {
      const local = localCatalog(409, false, true)
      await append(local, 'ambiguous')
      expect(local.tokens()).toEqual(['ambiguous'])
      expect(await local.rows()).toEqual([{ url: '/' }])
    })
  })
}
