import type { ManifestEntry, Watermark } from '../local-store'
import process from 'node:process'
import { filesystemStats } from '@gscdump/engine/filesystem'
import { defineCommand } from 'citty'
import { decodeSiteId, parseGscSiteUrl } from 'gscdump'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { columnsFor } from '../render/analysis'
import { barColumn } from '../render/charts'
import { renderTable, textLines } from '../render/layout'
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
    const rows = perTable.filter(({ live, retired }) => live.length || retired.length).map(({ table, live, retired }) => ({
      table,
      liveFiles: live.length,
      liveRows: sumRows(live),
      liveBytes: sumBytes(live),
      retiredFiles: retired.length,
      retiredBytes: sumBytes(retired),
    }))
    const retired = rows.some(row => row.retiredFiles > 0)
    const lines = [
      ...textLines(`Store / ${displayPath(store.dataDir)}`, options, 'accent'),
      ...textLines(`Disk ${formatMetric('bytes', disk.bytes)}  ${disk.files} files`, options),
      '',
      ...(rows.length
        ? renderTable(rows, [
            { key: 'table', label: 'Table' },
            ...columnsFor(rows, ['liveFiles', 'liveRows']),
            barColumn(rows, 'liveBytes', options),
            ...(retired
              ? [
                  { key: 'retiredFiles', label: 'Retired files', numeric: true },
                  { key: 'retiredBytes', label: 'Retired bytes', numeric: true, format: (value: unknown) => formatMetric('bytes', value) },
                ]
              : []),
          ], options)
        : textLines('Empty Store.', options)),
    ]
    if (rows.length > 1)
      lines.push(...textLines(`Total ${formatMetric('bytes', rows.reduce((sum, row) => sum + row.liveBytes, 0))} live`, options, 'muted'))
    if (watermarks.length) {
      lines.push('', ...renderTable(sortWatermarks(watermarks).map(w => ({
        scope: w.siteId ? `${w.table}@${parseGscSiteUrl(decodeSiteId(w.siteId)).hostname}` : w.table,
        dates: `${w.oldestDateSynced} to ${w.newestDateSynced}`,
        synced: formatAge(w.lastSyncAt),
      })), [{ key: 'scope', label: '' }, { key: 'dates', label: 'Dates' }, { key: 'synced', label: 'Synced' }], options))
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
