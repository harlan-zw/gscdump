import type { PreparedAppend, Resolver, TableMetadata } from 'icebird'
import { ByteWriter } from 'hyparquet-writer'
import { stageSnapshotForAppendBatches } from 'icebird/src/write/stage.js'
import { expect, it } from 'vitest'

it('preserves prior delete totals and snapshot properties for a batch append', async () => {
  const metadata = {
    'format-version': 2,
    'table-uuid': 'table-1',
    'current-schema-id': 0,
    'current-snapshot-id': 41,
    'last-sequence-number': 1,
    'snapshots': [{
      'snapshot-id': 41,
      'sequence-number': 1,
      'timestamp-ms': 1,
      'summary': {
        'operation': 'delete',
        'total-delete-files': '3',
        'total-position-deletes': '4',
        'total-equality-deletes': '5',
      },
    }],
  } as TableMetadata
  const prepared = [{
    snapshotId: 42n,
    manifestUuid: 'manifest-1',
    formatVersion: 2,
    manifestPath: 'memory://table/metadata/manifest-1.avro',
    manifestLength: 1n,
    partitionSpecId: 0,
    partitions: [],
    addedDataFilesCount: 1,
    addedRowCount: 1n,
    addedFilesSize: 10n,
    recordsCount: 1,
    writtenFiles: [],
  }] satisfies PreparedAppend[]
  const resolver = { writer: () => new ByteWriter() } as Resolver

  const staged = await stageSnapshotForAppendBatches({
    tableUrl: 'memory://table',
    metadata,
    prepared,
    resolver,
    snapshotProperties: { 'lakehouse.append-id': 'append-1' },
  })

  expect(staged.snapshot.summary).toMatchObject({
    'total-delete-files': '3',
    'total-position-deletes': '4',
    'total-equality-deletes': '5',
    'lakehouse.append-id': 'append-1',
  })
})
