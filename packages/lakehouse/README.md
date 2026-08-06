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
- `@gscdump/lakehouse/bigint`: bigint-safe JSON helpers without catalog or
  Node dependencies.
- `@gscdump/lakehouse/schema`: lightweight shared schema constants.
- `@gscdump/lakehouse/maintenance` — stable commit classification and orphan
  cleanup workflows.
- `@gscdump/lakehouse/provisioning` — adopt, allocate, or provision R2 Data
  Catalog resources.
- `@gscdump/lakehouse/unsafe-raw` — explicit escape hatch for package adapters
  and raw-metadata diagnostics. Application maintenance belongs on the stable
  maintenance subpath.

```ts
import { connectIcebergCatalog, listIcebergTables } from '@gscdump/lakehouse'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { isCommitRateLimited, isCommitTransient } from '@gscdump/lakehouse/maintenance'

const connection = await connectIcebergCatalog(config)
const tables = await listIcebergTables(connection)

try {
  // Commit through a dataset or package adapter.
}
catch (error) {
  if (isCommitRateLimited(error)) {
    // 429 specifically: decorrelate concurrent writers (defer off-slot).
  }
  else if (isCommitTransient(error)) {
    // 429 or an R2 5xx blip: worth another attempt at all.
  }
}
```

`isCommitRateLimited` stays 429-only; `isCommitServerError` covers transient
R2 5xx responses; `isCommitTransient` is the union and is what the package's
own append-retry loop uses.

The dataset registry is the normal authoring boundary. Raw Icebird table
creation and append primitives are intentionally excluded from the package
root so producers cannot silently bypass registered dataset definitions.

## License

[MIT](../../LICENSE)
