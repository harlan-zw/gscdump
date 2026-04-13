import type { ManifestEntry, TableName } from 'gscdump/analytics'
import process from 'node:process'
import { defineCommand } from 'citty'
import { allTables } from 'gscdump/analytics'
import { filesystemStats } from 'gscdump/analytics/filesystem'
import { createAnalyticsHarness } from '../analytics'
import { loadConfig } from '../config'
import { logger } from '../utils'

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
  },
  async run({ args }) {
    const config = await loadConfig()
    if (config.mode === 'cloud') {
      logger.error('stats queries the local Parquet store; cloud mode is not supported.')
      process.exit(1)
    }

    const harness = createAnalyticsHarness(config)
    const perTable = await Promise.all(
      allTables().map(async (table) => {
        const all = await harness.manifestStore.listAll({
          userId: harness.userId,
          table: table as TableName,
        })
        const live = all.filter(e => e.retiredAt === undefined)
        const retired = all.filter(e => e.retiredAt !== undefined)
        return { table, live, retired }
      }),
    )

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
    console.log()
  },
})

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
