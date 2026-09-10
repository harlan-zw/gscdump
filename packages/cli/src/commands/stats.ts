import type { ManifestEntry, Watermark } from '../local-store'
import process from 'node:process'
import { filesystemStats } from '@gscdump/engine/filesystem'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { renderBars, renderMetrics } from '../render/charts'
import { textLines } from '../render/layout'
import { formatMetric } from '../render/metrics'
import { terminalOutputOptions } from '../render/terminal'
import { applyOutputMode, displayPath, formatAge, logger, OUTPUT_ARGS } from '../utils'

export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description: 'Show row/byte counts per table and on-disk footprint',
  },
  args: {
    ...OUTPUT_ARGS,
    site: {
      type: 'string',
      description: 'Limit to one site URL (sc-domain:example.com, https://example.com/, ...)',
    },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    // Validate --site against the set of sites with local data so a typo
    // surfaces an error instead of silently showing zero.
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const allEntries = await store.engine.listAll({ userId: store.userId })
    let siteId: string | undefined
    if (args.site) {
      const known = new Set(
        allEntries
          .filter(entry => entry.retiredAt === undefined && entry.siteId !== undefined)
          .map(entry => entry.siteId!),
      )
      const candidate = store.siteIdFor(args.site)
      if (!known.has(candidate)) {
        logger.error(`No local data for --site=${args.site}. Known site IDs: ${known.size === 0 ? '(none — run \`gscdump sync\` first)' : Array.from(known).join(', ')}`)
        process.exit(1)
      }
      siteId = candidate
    }
    const selectedEntries = siteId === undefined
      ? allEntries
      : allEntries.filter(entry => entry.siteId === siteId)
    const perTable = allTables().map((table) => {
      const all = selectedEntries.filter(entry => entry.table === table)
      const live = all.filter(e => e.retiredAt === undefined)
      const retired = all.filter(e => e.retiredAt !== undefined)
      return { table, live, retired }
    })

    const [watermarks, disk] = await Promise.all([
      store.engine.getWatermarks({ userId: store.userId, siteId }),
      filesystemStats(store.dataDir).catch(() => ({ files: 0, bytes: 0 })),
    ])

    if (json) {
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

    const options = terminalOutputOptions()
    const lines = [
      ...textLines('gscdump / store stats', options, 'accent'),
      ...textLines(displayPath(store.dataDir), options),
      ...textLines(`Disk: ${disk.files} files, ${formatMetric('bytes', disk.bytes)}`, options),
      '',
      ...textLines('Live bytes by table', options),
      ...renderBars(perTable.map(({ table, live }) => ({ label: table, value: sumBytes(live) })), 'bytes', options),
      '',
    ]
    for (const { table, live, retired } of perTable) {
      lines.push(...textLines(`${table}: ${formatMetric('clicks', live.length)} files, ${formatMetric('clicks', sumRows(live))} rows`, options))
      if (retired.length)
        lines.push(...textLines(`Retired: ${retired.length} files, ${formatMetric('bytes', sumBytes(retired))}`, options, 'muted'))
    }
    lines.push('', ...renderMetrics([
      { key: 'liveFiles', label: 'Live files', current: perTable.reduce((sum, row) => sum + row.live.length, 0) },
      { key: 'liveRows', label: 'Live rows', current: perTable.reduce((sum, row) => sum + sumRows(row.live), 0) },
      { key: 'bytes', label: 'Live bytes', current: perTable.reduce((sum, row) => sum + sumBytes(row.live), 0) },
    ], options))
    if (watermarks.length) {
      lines.push('', ...textLines('Sync watermarks', options, 'accent'))
      for (const w of sortWatermarks(watermarks)) {
        lines.push(...textLines(w.siteId ? `${w.table}@${w.siteId}` : w.table, options))
        lines.push(...textLines(`${w.oldestDateSynced} to ${w.newestDateSynced} (last ${formatAge(w.lastSyncAt)})`, options, 'muted'))
      }
    }
    console.log(lines.join('\n'))
  },
})

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
