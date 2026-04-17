import type { ManifestEntry, TableName, Watermark } from 'gscdump/analytics/contracts'
import { defineCommand } from 'citty'
import { filesystemStats } from 'gscdump/analytics/filesystem'
import { allTables } from 'gscdump/analytics/schema'
import { createAnalyticsHarness } from '../analytics'
import { loadConfig } from '../config'

export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description: 'Show row/byte counts per table and on-disk footprint',
  },
  args: {
    json: {
      type: 'boolean',
      default: false,
      description: 'Output as JSON',
    },
    site: {
      type: 'string',
      description: 'Limit to one site URL (sc-domain:example.com, https://example.com/, ...)',
    },
  },
  async run({ args }) {
    const config = await loadConfig()
    const harness = createAnalyticsHarness(config)
    const siteId = args.site ? harness.siteIdFor(args.site) : undefined
    const perTable = await Promise.all(
      allTables().map(async (table) => {
        const all = await harness.engine.listAll({
          userId: harness.userId,
          siteId,
          table: table as TableName,
        })
        const live = all.filter(e => e.retiredAt === undefined)
        const retired = all.filter(e => e.retiredAt !== undefined)
        return { table, live, retired }
      }),
    )

    const watermarks = await harness.engine.getWatermarks({ userId: harness.userId, siteId })
    const disk = await filesystemStats(harness.dataDir).catch(() => ({ files: 0, bytes: 0 }))

    if (args.json) {
      const payload = {
        dataDir: harness.dataDir,
        disk,
        tables: perTable.map(({ table, live, retired }) => ({
          table,
          liveFiles: live.length,
          liveRows: sumRows(live),
          liveBytes: sumBytes(live),
          retiredFiles: retired.length,
          retiredBytes: sumBytes(retired),
          watermarks: watermarks
            .filter(w => w.table === table)
            .map(w => ({
              siteId: w.siteId ?? null,
              newestDateSynced: w.newestDateSynced,
              oldestDateSynced: w.oldestDateSynced,
              lastSyncAt: w.lastSyncAt,
            })),
        })),
      }
      console.log(JSON.stringify(payload, null, 2))
      return
    }

    console.log()
    console.log(`  \x1B[1m${harness.dataDir}\x1B[0m`)
    console.log(`  \x1B[90mDisk: ${disk.files} file(s), ${formatBytes(disk.bytes)}\x1B[0m`)
    console.log()

    const totalRows = perTable.reduce((acc, t) => acc + sumRows(t.live), 0)
    const totalBytes = perTable.reduce((acc, t) => acc + sumBytes(t.live), 0)
    const totalFiles = perTable.reduce((acc, t) => acc + t.live.length, 0)
    const totalRetiredFiles = perTable.reduce((acc, t) => acc + t.retired.length, 0)
    const totalRetiredBytes = perTable.reduce((acc, t) => acc + sumBytes(t.retired), 0)

    for (const { table, live, retired } of perTable) {
      const rows = sumRows(live).toLocaleString()
      const bytes = formatBytes(sumBytes(live))
      const retiredSuffix = retired.length > 0
        ? ` \x1B[90m(+${retired.length} retired, ${formatBytes(sumBytes(retired))})\x1B[0m`
        : ''
      console.log(`  ${table.padEnd(15)} \x1B[36m${String(live.length).padStart(4)}\x1B[0m files, ${rows.padStart(10)} rows, ${bytes}${retiredSuffix}`)
    }

    console.log()
    console.log(`  \x1B[1mTotal:\x1B[0m ${totalFiles} files, ${totalRows.toLocaleString()} rows, ${formatBytes(totalBytes)} live`)
    if (totalRetiredFiles > 0)
      console.log(`  \x1B[90mRetired: ${totalRetiredFiles} files, ${formatBytes(totalRetiredBytes)} awaiting GC\x1B[0m`)

    if (watermarks.length > 0) {
      console.log()
      console.log(`  \x1B[1mSync watermarks:\x1B[0m`)
      for (const w of sortWatermarks(watermarks)) {
        const scope = w.siteId ? `${w.table}@${w.siteId}` : w.table
        console.log(`  ${scope.padEnd(24)} \x1B[36m${w.oldestDateSynced}\x1B[0m → \x1B[36m${w.newestDateSynced}\x1B[0m  \x1B[90m(last ${formatTimestamp(w.lastSyncAt)})\x1B[0m`)
      }
    }

    console.log()
  },
})

function sortWatermarks(ws: Watermark[]): Watermark[] {
  return [...ws].sort((a, b) => {
    if (a.table !== b.table)
      return a.table.localeCompare(b.table)
    return (a.siteId ?? '').localeCompare(b.siteId ?? '')
  })
}

function formatTimestamp(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 60_000)
    return 'just now'
  if (delta < 3_600_000)
    return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000)
    return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

function sumRows(entries: ManifestEntry[]): number {
  return entries.reduce((acc, e) => acc + e.rowCount, 0)
}

function sumBytes(entries: ManifestEntry[]): number {
  return entries.reduce((acc, e) => acc + e.bytes, 0)
}

function formatBytes(n: number): string {
  if (n < 1024)
    return `${n} B`
  if (n < 1024 * 1024)
    return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024)
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
