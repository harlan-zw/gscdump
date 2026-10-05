import { describe, expect, it, vi } from 'vitest'
import { defineIcebergDataset } from '../src/dataset'

const load = vi.fn()
vi.stubGlobal('fetch', load)
const dataset = defineIcebergDataset({
  namespace: 'gsc',
  table: 'dates',
  identity: { kind: 'site-int', encoding: 'int' },
  columns: [{ name: 'date', type: 'DATE', required: true }],
  partition: [{ sourceColumn: 'site_id', name: 'site_id', transform: 'identity' }],
  naturalKey: ['date'],
})
const connection = { catalog: { type: 'rest', url: 'https://catalog.example.test' } as never, resolver: {} as never, namespace: 'gsc_v1' }
function metadata() {
  return { metadata: {
    'current-schema-id': 7,
    'schemas': [{ ...dataset.icebergSchema(), 'schema-id': 7 }],
    'default-spec-id': 4,
    'partition-specs': [{ ...dataset.icebergPartitionSpec(), 'spec-id': 4 }],
  } }
}
describe('dataset registry admission of provisioned tables', () => {
  it('loads the captured namespace fresh and accepts matching current schema and partition fields', async () => {
    load.mockResolvedValueOnce(new Response(JSON.stringify(metadata())))
    await expect(dataset.verifyTable(connection)).resolves.toEqual({ _tag: 'Ok' })
    expect(load).toHaveBeenLastCalledWith('https://catalog.example.test/v1/namespaces/gsc_v1/tables/dates', undefined)
  })
  it.each(['schema', 'partition'] as const)('refuses a listed table with the wrong %s', async (kind) => {
    const actual = structuredClone(metadata())
    if (kind === 'schema')
      actual.metadata.schemas[0]!.fields[0]!.type = 'string'
    else
      actual.metadata['partition-specs'][0]!.fields[0]!.transform = 'month'
    load.mockResolvedValueOnce(new Response(JSON.stringify(actual)))
    await expect(dataset.verifyTable(connection)).resolves.toEqual({ _tag: 'Err', reason: `${kind}-mismatch` })
  })
  it('refuses changed current metadata after a successful registry provisioning call', async () => {
    load.mockResolvedValueOnce(new Response(JSON.stringify(metadata())))
    await expect(dataset.createTable(connection)).resolves.toEqual([{ table: 'dates', ok: true }])
    const changed = structuredClone(metadata())
    changed.metadata.schemas[0]!.fields[0]!.type = 'string'
    load.mockResolvedValueOnce(new Response(JSON.stringify(changed)))
    await expect(dataset.verifyTable(connection)).resolves.toEqual({ _tag: 'Err', reason: 'schema-mismatch' })
  })
  it('propagates provider outages instead of accepting an absent table', async () => {
    load.mockRejectedValueOnce(new Error('Catalog unavailable'))
    await expect(dataset.verifyTable(connection)).rejects.toThrow('Catalog unavailable')
  })
})
