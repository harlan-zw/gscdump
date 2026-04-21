// Returns per-table same-origin URLs pointing at /api/r2-data/<key>. The
// client fetches each URL's bytes in parallel and registers them in
// DuckDB-WASM's virtual filesystem, then creates views over the virtual
// names. No httpfs, no CORS.
//
// Shape matches gscdump.com's /api/sites/:siteId/analysis-sources route:
//   { tables: { [tableName]: string[] }, generatedAt: string }

import type { ManifestEntry, TableName } from '@gscdump/engine'

const TABLES: TableName[] = ['pages', 'keywords', 'countries', 'devices', 'page_keywords']
const MONTHLY_PARTITION_RE = /^monthly\/(\d{4}-\d{2})$/
const DAILY_PARTITION_RE = /^daily\/(\d{4}-\d{2})-\d{2}$/

export default defineEventHandler(async (event) => {
  const origin = getRequestURL(event).origin

  // Piggyback the manifest route we already have — single source of truth
  // for which objects exist. In production a D1 ManifestStore lives here.
  const manifest = await $fetch<{ entries: ManifestEntry[] }>('/api/manifest', {
    baseURL: origin,
  })

  // Two-stage dedupe:
  //   1. Newest-createdAt wins per (table, partition) — R2 LIST surfaces every
  //      historical write; without a D1-backed retirement flag the freshest
  //      file for a given partition supersedes its predecessors.
  //   2. Monthly compacted partitions shadow the daily partitions they cover.
  //      `compact-r2` emits `monthly/YYYY-MM` that already unions every
  //      `daily/YYYY-MM-DD` for that month. Keeping both means a ~30×
  //      redundant file-count explosion and (with HTTP/1.1's 6-connection
  //      cap) multi-second boot times on localhost.
  const latestByKey = new Map<string, ManifestEntry>()
  for (const e of manifest.entries) {
    const k = `${e.table}|${e.partition}`
    const prior = latestByKey.get(k)
    if (!prior || e.createdAt > prior.createdAt)
      latestByKey.set(k, e)
  }

  const coveredMonthsByTable = new Map<string, Set<string>>()
  for (const e of latestByKey.values()) {
    const m = MONTHLY_PARTITION_RE.exec(e.partition)
    if (!m)
      continue
    const set = coveredMonthsByTable.get(e.table) ?? new Set<string>()
    set.add(m[1]!)
    coveredMonthsByTable.set(e.table, set)
  }

  const tables: Record<string, string[]> = {}
  for (const table of TABLES) {
    const monthsCovered = coveredMonthsByTable.get(table) ?? new Set<string>()
    const entries = [...latestByKey.values()]
      .filter((e) => {
        if (e.table !== table)
          return false
        // Drop daily files whose month has a monthly compact already.
        const daily = DAILY_PARTITION_RE.exec(e.partition)
        if (daily && monthsCovered.has(daily[1]!))
          return false
        return true
      })
      .sort((a, b) => a.partition.localeCompare(b.partition))
    // Embed byte size as `?s=` so HEAD probes answer without an R2 round-trip.
    tables[table] = entries.map(e => `${origin}/api/r2-data/${e.objectKey}?s=${e.bytes}`)
  }

  setHeader(event, 'Cache-Control', 'private, max-age=30')
  return { tables, generatedAt: new Date().toISOString() }
})
