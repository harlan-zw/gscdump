import type { DataSource, ManifestStore } from './storage'
import { tenantPrefix } from './storage'

export interface GcDeps {
  dataSource: DataSource
  manifestStore: ManifestStore
}

export interface GcOptions {
  userId?: string
  siteId?: string
}

const VERSION_RE = /__v(\d+)\.parquet$/

export async function gcOrphansImpl(
  deps: GcDeps,
  now: number,
  graceMs: number,
  opts: GcOptions = {},
): Promise<{ deleted: number }> {
  const cutoff = now - graceMs

  const retired = await deps.manifestStore.listRetired(cutoff)
  if (retired.length > 0) {
    await deps.dataSource.delete(retired.map(e => e.objectKey))
    await deps.manifestStore.delete(retired)
  }

  let sweptOrphans = 0
  if (opts.userId) {
    const prefix = tenantPrefix({ userId: opts.userId, siteId: opts.siteId })
    const [actualKeys, knownEntries] = await Promise.all([
      deps.dataSource.list(prefix),
      deps.manifestStore.listAll({ userId: opts.userId, siteId: opts.siteId }),
    ])
    const knownSet = new Set(knownEntries.map(e => e.objectKey))
    const orphans: string[] = []
    for (const key of actualKeys) {
      if (knownSet.has(key))
        continue
      const match = VERSION_RE.exec(key)
      if (!match)
        continue
      const version = Number(match[1])
      if (version <= cutoff)
        orphans.push(key)
    }
    if (orphans.length > 0) {
      await deps.dataSource.delete(orphans)
      sweptOrphans = orphans.length
    }
  }

  return { deleted: retired.length + sweptOrphans }
}
