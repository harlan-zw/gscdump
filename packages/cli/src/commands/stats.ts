import type { ManifestEntry, TableName, Watermark } from '../local-store'
import process from 'node:process'
import { filesystemStats } from '@gscdump/engine/filesystem'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { displayPath, formatAge, logger, setQuiet } from '../utils'

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
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress info/success output',
    },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    // Validate --site against the set of sites with local data so a typo
    // surfaces an error instead of silently showing zero.
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    let siteId: string | undefined
    if (args.site) {
      const known = await listKnownSiteIds(store)
      const candidate = store.siteIdFor(args.site)
      if (!known.has(candidate)) {
        logger.error(`No local data for --site=${args.site}. Known site IDs: ${known.size === 0 ? '(none — run \`gscdump sync\` first)' : Array.from(known).join(', ')}`)
        process.exit(1)
      }
      siteId = candidate
    }
    const perTable = await Promise.all(
      allTables().map(async (table) => {
        const all = await store.engine.listAll({
          userId: store.userId,
          siteId,
          table: table as TableName,
        })
        const live = all.filter(e => e.retiredAt === undefined)
        const retired = all.filter(e => e.retiredAt !== undefined)
        return { table, live, retired }
      }),
    )

    const watermarks = await store.engine.getWatermarks({ userId: store.userId, siteId })
    const disk = await filesystemStats(store.dataDir).catch(() => ({ files: 0, bytes: 0 }))

    if (args.json) {
      const payload = {
        dataDir: store.dataDir,
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
    console.log(`  \x1B[1m${displayPath(store.dataDir)}\x1B[0m`)
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
        console.log(`  ${scope.padEnd(24)} \x1B[36m${w.oldestDateSynced}\x1B[0m → \x1B[36m${w.newestDateSynced}\x1B[0m  \x1B[90m(last ${formatAge(w.lastSyncAt)})\x1B[0m`)
      }
    }

    console.log()
  },
})

async function listKnownSiteIds(store: { userId: string, engine: { listLive: (f: any) => Promise<ManifestEntry[]> } }): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const table of allTables()) {
    const entries = await store.engine.listLive({ userId: store.userId, table: table as TableName })
    for (const e of entries) {
      if (e.siteId)
        ids.add(e.siteId)
    }
  }
  return ids
}

function sortWatermarks(ws: Watermark[]): Watermark[] {
  return [...ws].sort((a, b) => {
    if (a.table !== b.table)
      return a.table.localeCompare(b.table)
    return (a.siteId ?? '').localeCompare(b.siteId ?? '')
  })
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
