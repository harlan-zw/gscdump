/**
 * Shared `icebergManifests` mock for the month-keyed manifest cache tests.
 *
 * Real `icebergManifests` fetches the manifest-list, applies `partitionFilter`
 * to each manifest's list-level `partitions` field-summary (skipping any
 * manifest it rejects), then walks the survivors. `resolveIcebergDataFiles`'s
 * month-cache path (`catalog.ts`) depends on that contract: its first,
 * list-only pass hands a filter that ALWAYS returns `false` (so nothing is
 * walked) purely to observe every surviving manifest's `manifest_path` +
 * `partitions` via the filter's 3rd argument, and its second pass walks only
 * the manifests a real `partitionFilter` — reading `manifest_path` off that
 * same 3rd argument — selects.
 *
 * A bare `vi.fn().mockResolvedValue(...)` cannot exercise any of that: it
 * ignores `partitionFilter` entirely, so the list-only pass observes nothing
 * and the month cache never has anything to key by. This fake mirrors the
 * real filtering contract instead.
 */

export interface ManifestFixture {
  /** Manifest path — the cache-grouping / walk-selection key (`manifest_path`). */
  path: string
  /** List-level partition field-summary bounds. Omitted = "can't prove single-month" (always walked, never cached). */
  partitions?: unknown[]
  /** This manifest's entries, in whatever shape the caller's `FakeEntry` uses. */
  entries: unknown[]
}

interface IcebergManifestsArgs { partitionFilter?: (partitions: unknown, specId: number, manifest: { manifest_path: string, partitions?: unknown[] }) => boolean }

/**
 * Build an `icebergManifests` mock implementation over a fixed manifest list.
 * Pass the SAME fixture set to both the list-only pass and the walking pass
 * (`icebergManifests.mockImplementation(fakeManifestWalker(fixtures))`) — the
 * fixture doesn't change between passes, only which manifests the caller's
 * filter admits.
 */
export function fakeManifestWalker(manifests: readonly ManifestFixture[]) {
  return async ({ partitionFilter }: IcebergManifestsArgs) => {
    return manifests
      .filter(m => !partitionFilter || partitionFilter(m.partitions, 0, { manifest_path: m.path, partitions: m.partitions }) !== false)
      .map(m => ({ url: m.path, entries: m.entries }))
  }
}
