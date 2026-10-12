# @gscdump/lakehouse

Dataset-agnostic Iceberg catalog, schema, and dataset-registry primitives for
R2 Data Catalog producers.

## Install

```bash
npm install @gscdump/lakehouse
```

Node.js 22 or newer is required.

## Public surfaces

- `@gscdump/lakehouse`: connect to a catalog, define datasets, derive table
  specifications, resolve data files, and use bigint-safe serialization.
- `@gscdump/lakehouse/bigint`: bigint-safe JSON helpers without catalog or
  Node dependencies.
- `@gscdump/lakehouse/schema`: lightweight shared schema constants.
- `@gscdump/lakehouse/maintenance`: stable commit classification, manifest
  merging, and orphan cleanup workflows.
- `@gscdump/lakehouse/provisioning`: adopt, allocate, or provision R2 Data
  Catalog resources.
- `@gscdump/lakehouse/unsafe-raw`: explicit escape hatch for package adapters
  and raw-metadata diagnostics. Application maintenance belongs on the stable
  maintenance subpath.

```ts
import { connectIcebergCatalog, listIcebergTables } from '@gscdump/lakehouse'

// Supply your catalog connection configuration.
const connection = await connectIcebergCatalog(config)
const tables = await listIcebergTables(connection)
console.log(tables)
```

For retry decisions, import `isCommitRateLimited`, `isCommitServerError`, or
`isCommitTransient` from `@gscdump/lakehouse/maintenance`.

`isCommitRateLimited` matches HTTP 429.
`isCommitServerError` matches transient R2 5xx responses.
`isCommitTransient` matches either class and drives the package's append retry loop.

Use the dataset registry to define datasets.
Raw Icebird table creation and append functions live under `unsafe-raw` for package adapters and diagnostics.

## Append retries

Supply a durable `commitRetry.appendId` when a dataset append belongs to a job or receipt.
Reuse that ID when the job retries, including retries after package upgrades.

Without an explicit ID, row appends derive a versioned ID from framed, typed record content.
Row order and object key order do not change the ID.

If only a legacy content ID matches, the append throws `LegacyAppendIdentityUnverifiable`.
The error includes `legacyAppendId`.
The legacy ID cannot prove whether the committed rows match the retry.
Verify the committed rows before supplying that legacy ID as an explicit `appendId`.
If the rows differ, use a new durable ID for the new append.
Do not retry with the error's legacy ID without checking the rows.

Before upgrading producers that derive IDs, drain their existing write tasks.
Do not run old and new derived-ID writers concurrently against the same table.
Older writers cannot recognize the new content ID format.

Batch appends already require an explicit `appendId` and retain that behavior.

## Manifest merging

Use `mergeIcebergManifests(connection, table, options)` from `@gscdump/lakehouse/maintenance`
to reduce current metadata reads for append-only v2 tables.
The connection supplies the exact catalog and namespace.
The operation preserves DATA files, their metadata and sequence numbers, and historical append snapshots and manifests.
It groups entries by partition specification and writes encoded manifests up to four MiB.
It bounds aggregate input and staged output to eight MiB each, with ten thousand live entries.
Options can lower these limits.

`Merged` reports the snapshot ID, manifest counts, and file count.
`Unchanged` avoids writes when merging cannot reduce the manifest count.
`Conflict` leaves a concurrent UUID or main-snapshot change intact.
Reload the current head before a later attempt.
`Err` reports unsupported formats, deletes, invalid inventory, exceeded limits, or changed external authority.
Infrastructure errors propagate.
Non-null DATA metadata fields unsupported by the v2 writer, including encryption metadata, produce `invalid-inventory`.

Supply `confirmAuthority` to recheck external authority immediately before the catalog commit.
Returning false prevents that commit; callback exceptions propagate.
This callback does not create an atomic transaction with an external database.
Supply `cache` to invalidate the captured namespace and table's cached snapshot pointer after success.

Failed or uncertain commits retain staged metadata.
An uncertain response may follow a successful commit, so deleting staged files could break the table.
The operation never expires historical snapshots or deletes historical manifests.
Keep those objects while authenticated receipts or append retries still need them.

## License

[MIT](../../LICENSE)
