# Lakehouse snapshot retention

`expireIcebergSnapshots` removes selected historical snapshots from Catalog metadata.
It preserves the current snapshot and does not delete storage objects.

Import it from `@gscdump/lakehouse/maintenance`.

## Preview the policy

`planIcebergSnapshotRetention` reads fresh Catalog metadata and returns a proposed bounded removal list.
It uses the same planning function as `expireIcebergSnapshots`.
It sends no Catalog mutation and requires no storage writer.

Pass `olderThanMs`, `retainLast`, `protectedSnapshotIds`, and optionally `maxExpired`.
The `Planned` result includes the table UUID, current head, total snapshot count, and proposed IDs.
`eligibleSnapshotCount` includes candidates beyond the bounded removal list.
An empty table returns `Empty`. Invalid policy, inventory, or references return `Err`.

A preview records one observation. It does not reserve the head or grant future expiry authority.
If inventory or caller protection changes, rebuild the preview.
The mutation operation always reloads metadata and replans before checking authority.

## Apply the policy

| Option | Contract |
| --- | --- |
| `olderThanMs` | Keep every snapshot at or after this timestamp. Pass an explicit clock-derived cutoff. |
| `retainLast` | Keep at least this many newest snapshots, independently of age. Must be positive. |
| `protectedSnapshotIds` | Keep snapshots required for in-flight writes, replay, recovery, and rollback. Unknown IDs refuse the operation. |
| `confirmAuthority` | Recheck caller authority immediately before commit. The caller excludes branch and tag changes through commit settlement. |
| `maxExpired` | Remove at most this many snapshots in one commit. Defaults to 1,000. |
| `cache` | Invalidate the supplied Catalog cache after an acknowledged commit. |

The operation accepts a Catalog with only its main reference.
Additional branches or tags return `unsupported-refs`.
The caller owns its retention policy, active writers, legal holds, and restore window.
Removing snapshot metadata can remove append-retry evidence.
Do not expire snapshots needed by an operation that can replay.

The Catalog commit asserts both table UUID and current main snapshot.
A concurrent head change returns `Conflict`. Refresh and replan through the caller's normal maintenance flow.

Success requires an acknowledgement matching the planned remaining snapshot IDs and unchanged head.
A failed transport or mismatched acknowledgement throws. The caller must reconcile its actual Catalog state.
Do not treat that failure as proof that the Catalog rejected the write.

Snapshot expiry and file cleanup are separate operations.
Before deleting objects, prove they are unreachable from every retained snapshot, selected record, and supported restore point.
Manifest merging can reduce current manifest fanout while retaining file identity.
It does not establish that data files can be rewritten or deleted.
