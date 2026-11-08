import type { IcebergConnection } from '../src/catalog'
import { afterEach, expect, it, vi } from 'vitest'
import { dropIcebergTables } from '../src/index'
import { restoreIcebergTable } from '../src/maintenance'

afterEach(() => vi.unstubAllGlobals())

const uuid = '00000000-0000-4000-8000-000000000001'
const location = 's3://drill-bucket/source/metadata/backup.json'
const head = '9007199254740993'

async function fixture(options: { exists?: boolean, postFailure?: boolean, wrongIdentity?: boolean, oversized?: boolean, malformed?: boolean } = {}) {
  const metadata = { 'format-version': 2, 'table-uuid': uuid, 'current-snapshot-id': head, 'snapshots': [{ 'snapshot-id': '1', 'timestamp-ms': 1 }, { 'snapshot-id': head, 'timestamp-ms': 2 }] }
  const json = options.malformed ? 'invalid json' : JSON.stringify(metadata).replaceAll(`"${head}"`, head)
  const bytes = new TextEncoder().encode(json)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  const posts: unknown[] = []
  const reads: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      if (options.postFailure)
        throw new Error('Lost registration response')
      return new Response(`{"metadata-location":"${location}","metadata":${options.wrongIdentity ? json.replace(uuid, '00000000-0000-4000-8000-000000000099') : json}}`, { headers: { 'content-type': 'application/json' } })
    }
    reads.push(String(input))
    return options.exists
      ? new Response(`{"metadata-location":"${location}","metadata":${json}}`, { headers: { 'content-type': 'application/json' } })
      : Response.json({ error: { message: 'Missing table' } }, { status: 404 })
  })
  const conn = {
    namespace: 'source',
    catalog: { type: 'rest', url: 'https://catalog.test', prefix: '', defaults: {}, overrides: {} },
    resolver: { reader: async () => ({ byteLength: options.oversized ? 100_000_000 : bytes.byteLength, slice: async (start: number, end: number) => bytes.slice(start, end).buffer }) },
  } as unknown as IcebergConnection
  const policy = { metadataLocation: location, metadataSha256: sha256, tableUuid: uuid, headSnapshotId: head, snapshotIds: ['1', head], confirmAuthority: async () => true }
  return { conn, policy, posts, reads }
}

it('registers an intact backup in an empty target without replacing a table', async () => {
  const f = await fixture()
  expect(await restoreIcebergTable(f.conn, 'queries', f.policy)).toEqual({ _tag: 'Restored', tableUuid: uuid, snapshotIds: ['1', head] })
  expect(f.posts).toEqual([{ 'name': 'queries', 'metadata-location': location, 'overwrite': false }])
})

it('refuses an occupied target, including one with matching backup identity', async () => {
  const f = await fixture({ exists: true })
  expect(await restoreIcebergTable(f.conn, 'queries', f.policy)).toEqual({ _tag: 'Err', reason: 'target-exists' })
  expect(f.posts).toEqual([])
})

it('refuses corrupt backup bytes before registration', async () => {
  const f = await fixture()
  expect(await restoreIcebergTable(f.conn, 'queries', { ...f.policy, metadataSha256: '0'.repeat(64) })).toEqual({ _tag: 'Err', reason: 'backup-invalid' })
  expect(f.posts).toEqual([])
})

it('refuses malformed metadata even when its digest matches', async () => {
  const f = await fixture({ malformed: true })
  expect(await restoreIcebergTable(f.conn, 'queries', f.policy)).toEqual({ _tag: 'Err', reason: 'backup-invalid' })
  expect(f.posts).toEqual([])
})

it.each(['uuid', 'snapshot'] as const)('refuses a descriptor with the wrong %s before registration', async (wrong) => {
  const f = await fixture()
  const policy = wrong === 'uuid' ? { ...f.policy, tableUuid: '00000000-0000-4000-8000-000000000099' } : { ...f.policy, headSnapshotId: '1', snapshotIds: ['1'] }
  expect(await restoreIcebergTable(f.conn, 'queries', policy)).toEqual({ _tag: 'Err', reason: 'backup-invalid' })
  expect(f.posts).toEqual([])
})

it('bounds metadata reads before registration', async () => {
  const f = await fixture({ oversized: true })
  expect(await restoreIcebergTable(f.conn, 'queries', f.policy)).toEqual({ _tag: 'Err', reason: 'backup-invalid' })
  expect(f.posts).toEqual([])
})

it('refuses invalid archive identity before Catalog access', async () => {
  const f = await fixture()
  expect(await restoreIcebergTable(f.conn, 'queries', { ...f.policy, snapshotIds: ['1', '1'] })).toEqual({ _tag: 'Err', reason: 'invalid-options' })
  expect(f.reads).toEqual([])
  expect(f.posts).toEqual([])
})

it.each(['https://outside.test/backup.json', 's3://drill-bucket/a.json?token=value', 's3://drill-bucket/a.json#fragment'])('refuses unsafe metadata location %s', async (metadataLocation) => {
  const f = await fixture()
  expect(await restoreIcebergTable(f.conn, 'queries', { ...f.policy, metadataLocation })).toEqual({ _tag: 'Err', reason: 'invalid-options' })
  expect(f.reads).toEqual([])
})

it('checks authority before access and again before registering', async () => {
  const f = await fixture()
  expect(await restoreIcebergTable(f.conn, 'queries', { ...f.policy, confirmAuthority: async () => false })).toEqual({ _tag: 'Err', reason: 'authority-changed' })
  expect(f.reads).toEqual([])
  let checks = 0
  expect(await restoreIcebergTable(f.conn, 'queries', { ...f.policy, confirmAuthority: async () => ++checks === 1 })).toEqual({ _tag: 'Err', reason: 'authority-changed' })
  expect(f.posts).toEqual([])
})

it('reports unknown registration outcomes without retrying or removing anything', async () => {
  const f = await fixture({ postFailure: true })
  const result = await restoreIcebergTable(f.conn, 'queries', f.policy)
  expect(result).toMatchObject({ _tag: 'Unknown', reason: 'request-failed', cause: expect.objectContaining({ message: 'Lost registration response' }) })
  expect(f.posts).toEqual([{ 'name': 'queries', 'metadata-location': location, 'overwrite': false }])
})

it('refuses an acknowledgement with a different table identity', async () => {
  const f = await fixture({ wrongIdentity: true })
  expect(await restoreIcebergTable(f.conn, 'queries', f.policy)).toEqual({ _tag: 'Unknown', reason: 'acknowledgement-invalid' })
})

it.each([false, true])('drops a Catalog registration with explicit purge=%s', async (purge) => {
  const urls: URL[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input)))
    return new Response(null, { status: 204 })
  })
  const conn = { namespace: 'source', catalog: { type: 'rest', url: 'https://catalog.test', prefix: '', defaults: {}, overrides: {} } } as IcebergConnection
  expect(await dropIcebergTables(conn, ['queries'], { purge })).toEqual([{ table: 'queries', ok: true }])
  expect(urls.map(url => url.searchParams.get('purgeRequested') === 'true')).toEqual([purge])
})
