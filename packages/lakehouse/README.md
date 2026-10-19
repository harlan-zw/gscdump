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

## Opt-in manifest read limits

`icebergManifests` on `@gscdump/lakehouse/unsafe-raw` accepts an optional
`readLimits: ManifestReadLimits`. Omission preserves the existing reader and
caller-owned manifest cache behavior. No higher-level file resolver or host
automatically enables these limits.

```ts
import { icebergManifests } from '@gscdump/lakehouse/unsafe-raw'

const manifests = await icebergManifests({
  metadata,
  resolver,
  readLimits: {
    maxObjectBytes: 2 * 1024 * 1024,
    maxTotalObjectBytes: 8 * 1024 * 1024,
    maxManifests: 8,
    maxEntries: 128,
    maxInflatedBlockBytes: 2 * 1024 * 1024,
    maxTotalInflatedBytes: 8 * 1024 * 1024,
    maxValueBytes: 1024 * 1024,
    maxDecodedValues: 100_000,
    maxHeaderBytes: 64 * 1024,
    maxSchemaDepth: 32,
  },
})
```

These are example admission values, not defaults or a total JavaScript heap
guarantee. Every field is required and must be a positive safe integer;
`maxSchemaDepth` must also be at most 128. The reader copies and validates the
policy before its first asynchronous read. Unknown fields are rejected.

The per-object and cumulative source-byte checks happen after `resolver.reader`
reports `byteLength`, **before** the reader requests `slice(0, byteLength)`.
Declared manifest lengths and returned slice lengths must match. An injected
resolver can allocate or fetch inside `reader` itself; those operations are
outside this boundary and need their own transport limits and immutable-object
identity checks. No HEAD, catalog JSON, network-request, or freshness bound is
implied by this option.

Manifest-list counts are admitted before record materialization and pruning;
entry counts accumulate across all fetched manifests and blocks. V1 inline
manifest counts are admitted before reads, with each file decoded once in a
private per-call cache. Supplying `manifestCache` with `readLimits` is rejected:
previously decoded cache entries carry no verifiable budget provenance. Defaults
retain their existing cache behavior.

For Avro `null` and raw `deflate` blocks, decoded block bytes and their cumulative
total are bounded. The existing pure-JavaScript inflater checks output growth
before allocating or writing past that limit. Bounded DEFLATE returns an exact-size
backing buffer so byte views do not retain spare inflater capacity; growth and
final-copy buffers can temporarily overlap. Header framing is byte-bounded
before JSON parsing; schema depth/work is checked before recursive compilation.
Variable and fixed values are checked before views or UTF-8 decoding, and
`maxDecodedValues` bounds decoding work across header/schema nodes and decoded
value visits, including arrays of zero-byte nulls. Strict reads also reject
invalid counts, varints, indexes, truncated values and inconsistent block sizes.

These limits do not measure JavaScript object/string overhead, the JSON parser's
internal allocations, inflater tables, caller-retained output, injected resolver
caches or total process memory. Output remains an eager array within the chosen
count/byte/work policy. A refusal rejects the complete call; there is no eager
fallback or partial success. Already-dispatched resolver reads cannot be
physically cancelled by the AsyncBuffer interface, but a first failure stops new
dispatches and prevents late responses from being decoded. Choose compatible
limits and validate the complete consumer path before enabling them.

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
