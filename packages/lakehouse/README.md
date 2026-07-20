# @gscdump/lakehouse

Dataset-agnostic Iceberg catalog, schema, and dataset-registry primitives for
R2 Data Catalog producers.

## Install

```bash
npm install @gscdump/lakehouse
```

Node.js 22 or newer is required.

## Public surfaces

- `@gscdump/lakehouse` — connect to a catalog, define datasets, derive table
  specifications, resolve data files, and use bigint-safe serialization.
- `@gscdump/lakehouse/maintenance` — stable commit classification and orphan
  cleanup workflows.
- `@gscdump/lakehouse/provisioning` — adopt, allocate, or provision R2 Data
  Catalog resources.
- `@gscdump/lakehouse/unsafe-raw` — explicit escape hatch for package adapters
  and raw-metadata diagnostics. Application maintenance belongs on the stable
  maintenance subpath.

```ts
import { connectIcebergCatalog, listIcebergTables } from '@gscdump/lakehouse'
import { isCommitRateLimited } from '@gscdump/lakehouse/maintenance'

const connection = await connectIcebergCatalog(config)
const tables = await listIcebergTables(connection)

try {
  // Commit through a dataset or package adapter.
}
catch (error) {
  if (isCommitRateLimited(error)) {
    // Retry using the caller's bounded backoff policy.
  }
}
```

The dataset registry is the normal authoring boundary. Raw Icebird table
creation and append primitives are intentionally excluded from the package
root so producers cannot silently bypass registered dataset definitions.

## License

[MIT](../../LICENSE)
