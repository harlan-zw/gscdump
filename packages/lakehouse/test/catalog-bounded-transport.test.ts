import type { ResolveIcebergDataFilesOptions } from '../src/catalog'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, limits } from './bounded-avro-fixtures'

const { restCatalogLoadTable, s3SignedResolver } = vi.hoisted(() => ({ restCatalogLoadTable: vi.fn(), s3SignedResolver: vi.fn() }))
vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect: vi.fn(async ({ url }: { url: string }) => ({ type: 'rest', url, prefix: '', defaults: {}, overrides: {} })), restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable }))
vi.mock('icebird/src/s3.js', () => ({ s3SignedResolver }))
const { connectIcebergCatalog, resolveIcebergDataFiles } = await import('../src/catalog')

const options: ResolveIcebergDataFilesOptions = {
  namespace: 'gsc',
  table: 'dates',
  partitionSpec: [
    { sourceColumn: 'site_id', transform: 'identity', name: 'site_id' },
    { sourceColumn: 'date', transform: 'month', name: 'date_month' },
  ],
  matches: [{ field: 'site_id', value: 7, encoding: 'int32' }],
  range: { start: '2026-10-01', end: '2026-10-31' },
}

async function connect() {
  const f = fixture(2)
  restCatalogLoadTable.mockResolvedValue({ metadata: f.metadata })
  s3SignedResolver.mockReturnValue(f.resolver)
  const conn = await connectIcebergCatalog({
    catalogUri: 'https://catalog.invalid',
    warehouse: 'synthetic',
    namespace: 'gsc',
    catalogToken: 'test',
    s3: { endpoint: 'https://s3.invalid', accessKeyId: 'test', secretAccessKey: 'test' },
  })
  const sourceBytes = [...f.objects.values()].reduce((n, bytes) => n + bytes.byteLength, 0)
  const readBytes = (): number => f.reads.reduce((n, r) => n + r.bytes, 0)
  return { f, conn, sourceBytes, readBytes }
}

describe('connection resolver cache under read limits', () => {
  beforeEach(() => {
    restCatalogLoadTable.mockReset()
    s3SignedResolver.mockReset()
  })

  it('keeps manifest bytes from an unbounded resolution for the next call', async () => {
    const { f, conn, sourceBytes, readBytes } = await connect()
    const files = await resolveIcebergDataFiles(conn, options)
    expect(readBytes()).toBe(sourceBytes)
    f.reads.length = 0
    expect(await resolveIcebergDataFiles(conn, options)).toEqual(files)
    expect(readBytes()).toBe(0)
  })

  it('retains no manifest bytes in the connection after a bounded resolution', async () => {
    const { f, conn, sourceBytes, readBytes } = await connect()
    const files = await resolveIcebergDataFiles(conn, { ...options, readLimits: limits })
    expect(readBytes()).toBe(sourceBytes)
    f.reads.length = 0
    // A later call can only reuse bytes the connection kept, so a full re-read proves nothing was kept.
    expect(await resolveIcebergDataFiles(conn, options)).toEqual(files)
    expect(readBytes()).toBe(sourceBytes)
  })

  it('retains no manifest bytes after a bounded resolution fails a limit', async () => {
    const { f, conn, sourceBytes, readBytes } = await connect()
    const listBytes = f.objects.get('memory://list')!.byteLength
    await expect(resolveIcebergDataFiles(conn, { ...options, readLimits: { ...limits, maxTotalObjectBytes: listBytes + 1 } })).rejects.toThrow('objectBytes')
    f.reads.length = 0
    await resolveIcebergDataFiles(conn, options)
    expect(readBytes()).toBe(sourceBytes)
  })
})
