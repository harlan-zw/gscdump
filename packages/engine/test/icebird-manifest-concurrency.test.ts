import type { Resolver, Snapshot } from 'icebird'
import { ByteWriter } from 'hyparquet-writer'
import { avroWrite } from 'icebird/avro'
import { resolveInlineManifests } from 'icebird/src/manifest.js'
import { expect, it } from 'vitest'

const manifestSchema: Parameters<typeof avroWrite>[0]['schema'] = {
  type: 'record',
  name: 'manifest_entry',
  fields: [
    { name: 'status', type: 'int' },
    {
      name: 'data_file',
      type: {
        type: 'record',
        name: 'data_file',
        fields: [{ name: 'record_count', type: 'long' }],
      },
    },
  ],
}

async function createManifestBytes(): Promise<ArrayBuffer> {
  const writer = new ByteWriter()
  await avroWrite({
    writer,
    schema: manifestSchema,
    records: [{ status: 1, data_file: { record_count: 1n } }],
    metadata: { 'partition-spec-id': '0' },
  })
  return writer.getBuffer()
}

it('bounds concurrent reads of v1 inline manifests', async () => {
  const bytes = await createManifestBytes()
  const paths = Array.from({ length: 9 }, (_, index) => `memory://manifest-${index}.avro`)
  let activeReads = 0
  let maxActiveReads = 0
  const resolver = {
    reader: () => ({
      byteLength: bytes.byteLength,
      slice: async (start: number, end?: number) => {
        activeReads++
        maxActiveReads = Math.max(maxActiveReads, activeReads)
        await new Promise(resolve => setTimeout(resolve, 2))
        activeReads--
        return bytes.slice(start, end)
      },
    }),
  } satisfies Resolver
  const snapshot = {
    'snapshot-id': 1n,
    'sequence-number': 0,
    'timestamp-ms': 0,
    'manifest-list': '',
    'manifests': paths,
    'summary': { operation: 'append' },
  } satisfies Snapshot

  const manifests = await resolveInlineManifests(snapshot, resolver)

  expect(manifests.map(manifest => manifest.manifest_path)).toEqual(paths)
  expect(maxActiveReads).toBe(8)
})
