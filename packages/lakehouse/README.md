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
- `@gscdump/lakehouse/maintenance`: stable commit classification and orphan
  cleanup workflows.
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

## License

[MIT](../../LICENSE)
