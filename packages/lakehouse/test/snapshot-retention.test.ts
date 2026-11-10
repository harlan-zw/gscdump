import type { IcebergConnection } from '../src/catalog'
import { afterEach, expect, it, vi } from 'vitest'
import { expireIcebergSnapshots, planIcebergSnapshotRetention } from '../src/maintenance'

afterEach(() => vi.unstubAllGlobals())

function fixture(options: { conflict?: boolean, responseLost?: boolean, branch?: boolean, ignoreRemoval?: boolean, duplicateAcknowledgement?: boolean, empty?: boolean } = {}) {
  const requests: Record<string, unknown>[] = []
  const snapshots = (options.empty ? [] : [1, 2, 3, 4, 5]).map(id => ({ 'snapshot-id': id, 'timestamp-ms': id * 1000, 'manifest-list': `s3://bucket/table/${id}.avro` }))
  const metadata = { 'format-version': 2, 'table-uuid': 'table-uuid', 'current-snapshot-id': options.empty ? undefined : 5, 'snapshots': snapshots, 'refs': { ...(!options.empty ? { main: { 'type': 'branch', 'snapshot-id': 5 } } : {}), ...(options.branch ? { audit: { 'type': 'tag', 'snapshot-id': 1 } } : {}) } }
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      requests.push(body)
      if (options.conflict)
        return Response.json({ error: { message: 'Conflict' } }, { status: 409 })
      const removed = new Set(body.updates.flatMap((update: { 'snapshot-ids': number[] }) => update['snapshot-ids']))
      if (!options.ignoreRemoval)
        metadata.snapshots = metadata.snapshots.filter(snapshot => !removed.has(snapshot['snapshot-id']))
      if (options.duplicateAcknowledgement)
        metadata.snapshots[0] = metadata.snapshots[1]!
      if (options.responseLost)
        return Response.json({ error: { message: 'Unknown result' } }, { status: 503 })
    }
    return Response.json({ 'metadata-location': 'memory://metadata.json', metadata })
  })
  const conn = { namespace: 'site_version', catalog: { type: 'rest', url: 'https://catalog.test', prefix: '', defaults: {}, overrides: {} } } as IcebergConnection
  return { conn, metadata, requests }
}

it('expires only old unprotected history while keeping the head and minimum history', async () => {
  const f = fixture()
  expect(await expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: ['1'], confirmAuthority: async () => true }))
    .toEqual({ _tag: 'Expired', snapshotIds: ['2', '3'], retained: 3 })
  expect(f.metadata.snapshots.map(snapshot => snapshot['snapshot-id'])).toEqual([1, 4, 5])
  expect(f.requests).toEqual([{ requirements: [{ type: 'assert-table-uuid', uuid: 'table-uuid' }, { 'type': 'assert-ref-snapshot-id', 'ref': 'main', 'snapshot-id': 5 }], updates: [{ 'action': 'remove-snapshots', 'snapshot-ids': [2, 3] }] }])
})

it('refuses unknown protected history and additional refs without writing', async () => {
  const f = fixture()
  expect(await expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: ['99'], confirmAuthority: async () => true }))
    .toEqual({ _tag: 'Err', reason: 'invalid-inventory' })
  expect(f.requests).toEqual([])
  const branch = fixture({ branch: true })
  expect(await expireIcebergSnapshots(branch.conn, 'queries', { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: [], confirmAuthority: async () => true }))
    .toEqual({ _tag: 'Err', reason: 'unsupported-refs' })
  expect(branch.requests).toEqual([])
})

it('checks current authority immediately before a fenced commit', async () => {
  const f = fixture()
  expect(await expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: [], confirmAuthority: async () => false }))
    .toEqual({ _tag: 'Err', reason: 'authority-changed' })
  expect(f.requests).toEqual([])
})

it('returns a conflict instead of removing a concurrent head', async () => {
  const f = fixture({ conflict: true })
  expect(await expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: [], confirmAuthority: async () => true })).toEqual({ _tag: 'Conflict' })
  expect(f.metadata.snapshots.map(snapshot => snapshot['snapshot-id'])).toEqual([1, 2, 3, 4, 5])
})

it('surfaces an unknown commit outcome for caller reconciliation', async () => {
  const f = fixture({ responseLost: true })
  await expect(expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: [], confirmAuthority: async () => true })).rejects.toThrow('503')
  expect(f.metadata.snapshots.map(snapshot => snapshot['snapshot-id'])).toEqual([4, 5])
})

it('refuses an acknowledgement that did not apply the planned retention', async () => {
  const f = fixture({ ignoreRemoval: true })
  await expect(expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: [], confirmAuthority: async () => true }))
    .rejects
    .toThrow('Snapshot expiry acknowledgement does not match the committed plan.')
})

it('rejects duplicate IDs that hide a missing protected snapshot in the acknowledgement', async () => {
  const f = fixture({ duplicateAcknowledgement: true })
  await expect(expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: ['1'], confirmAuthority: async () => true }))
    .rejects
    .toThrow('Snapshot expiry acknowledgement does not match the committed plan.')
})

it('bounds removals and preserves snapshots exactly at the cutoff', async () => {
  const f = fixture()
  expect(await expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 3000, retainLast: 1, protectedSnapshotIds: [], maxExpired: 1, confirmAuthority: async () => true }))
    .toEqual({ _tag: 'Expired', snapshotIds: ['1'], retained: 4 })
  expect(f.metadata.snapshots.map(snapshot => snapshot['snapshot-id'])).toEqual([2, 3, 4, 5])
})

it.each([0, -1, 1.5, Number.NaN, 1001])('refuses an invalid removal bound %s without a write', async (maxExpired) => {
  const f = fixture()
  expect(await expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 1, protectedSnapshotIds: [], maxExpired, confirmAuthority: async () => true }))
    .toEqual({ _tag: 'Err', reason: 'invalid-options' })
  expect(f.requests).toEqual([])
})

it('refuses missing protected history even when the table is empty', async () => {
  const f = fixture({ empty: true })
  expect(await expireIcebergSnapshots(f.conn, 'queries', { olderThanMs: 5000, retainLast: 1, protectedSnapshotIds: ['1'], confirmAuthority: async () => true }))
    .toEqual({ _tag: 'Err', reason: 'invalid-inventory' })
  expect(f.requests).toEqual([])
})

it('previews the same bounded removals without sending a Catalog mutation', async () => {
  const f = fixture()
  const options = { olderThanMs: 5000, retainLast: 2, protectedSnapshotIds: ['1'], maxExpired: 1 }
  expect(await planIcebergSnapshotRetention({ catalog: f.conn.catalog, namespace: f.conn.namespace }, 'queries', options)).toEqual({
    _tag: 'Planned',
    tableUuid: 'table-uuid',
    headSnapshotId: '5',
    snapshotIds: ['2'],
    snapshotCount: 5,
    retained: 4,
    eligibleSnapshotCount: 2,
  })
  expect(f.requests).toEqual([])
  expect(await expireIcebergSnapshots(f.conn, 'queries', { ...options, confirmAuthority: async () => true }))
    .toEqual({ _tag: 'Expired', snapshotIds: ['2'], retained: 4 })
})

it.each([undefined, -1])('previews and leaves an empty inventory unchanged with head %s', async (head) => {
  const f = fixture({ empty: true })
  f.metadata['current-snapshot-id'] = head
  const options = { olderThanMs: 5000, retainLast: 1, protectedSnapshotIds: [] }
  expect(await planIcebergSnapshotRetention(f.conn, 'queries', options)).toEqual({ _tag: 'Empty', tableUuid: 'table-uuid' })
  expect(await expireIcebergSnapshots(f.conn, 'queries', { ...options, confirmAuthority: async () => true })).toEqual({ _tag: 'Unchanged' })
  expect(f.requests).toEqual([])
})

it.each(['invalid-options', 'invalid-inventory', 'unsupported-refs'] as const)('refuses an unsafe preview for %s', async (reason) => {
  const f = fixture({ branch: reason === 'unsupported-refs' })
  expect(await planIcebergSnapshotRetention(f.conn, 'queries', {
    olderThanMs: reason === 'invalid-options' ? -1 : 5000,
    retainLast: 1,
    protectedSnapshotIds: reason === 'invalid-inventory' ? ['99'] : [],
  })).toEqual({ _tag: 'Err', reason })
  expect(f.requests).toEqual([])
})

it('returns a complete no-removal preview when policy retains all history', async () => {
  const f = fixture()
  expect(await planIcebergSnapshotRetention(f.conn, 'queries', { olderThanMs: 5000, retainLast: 5, protectedSnapshotIds: [] })).toEqual({
    _tag: 'Planned',
    tableUuid: 'table-uuid',
    headSnapshotId: '5',
    snapshotIds: [],
    snapshotCount: 5,
    retained: 5,
    eligibleSnapshotCount: 0,
  })
  expect(f.requests).toEqual([])
})
