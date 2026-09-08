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

## License

[MIT](../../LICENSE)
