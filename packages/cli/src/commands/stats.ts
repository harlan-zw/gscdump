import type { ManifestEntry, Watermark } from '../local-store'
import { filesystemStats } from '@gscdump/engine/filesystem'
import { defineCommand } from 'citty'
import { createCommandContext, siteArg } from '../context'
import { allTables, tableDimensions } from '../local-store'
import { columnsFor } from '../render/analysis'
import { barColumn } from '../render/charts'
import { renderTable, textLines } from '../render/layout'
import { formatMetric } from '../render/metrics'
import { terminalOutputOptions } from '../render/terminal'
import { readSiteMap, siteUrlForId } from '../store-sites'
import { applyOutputMode, displayPath, formatAge, OUTPUT_ARGS } from '../utils'

export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description: 'Show row/byte counts per table and on-disk footprint',
  },
  args: {
    ...OUTPUT_ARGS,
    site: {
      type: 'string',
      description: 'Limit to one Site, for example example.com',
    },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const siteUrl = args.site ? await ctx.resolveSite(String(args.site), { scope: 'store' }) : undefined
    const siteId = siteUrl ? store.siteIdFor(siteUrl) : undefined
    const [allEntries, siteMap] = await Promise.all([
      store.engine.listAll({ userId: store.userId }),
      readSiteMap(store.dataDir, store.userId),
    ])
    const knownSites = [...new Set(allEntries
      .filter(entry => entry.retiredAt === undefined && entry.siteId !== undefined)
      .map(entry => siteUrlForId(siteMap, entry.siteId!)))]
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
      filesystemStats(store.dataDir),
    ])

    if (json) {
      const payload = {
        dataDir: store.dataDir,
        siteUrl: siteUrl ?? null,
        knownSites,
        nextCommand: `gscdump sync${siteUrl ? ` --site ${siteArg(siteUrl)}` : ''} --status --json`,
        disk,
        tables: perTable.map(({ table, live, retired }) => ({
          table,
          dimensions: tableDimensions(table),
          liveFiles: live.length,
          liveRows: sumRows(live),
          liveBytes: sumBytes(live),
          retiredFiles: retired.length,
          retiredBytes: sumBytes(retired),
          watermarks: watermarks
            .filter(w => w.table === table)
            .map(w => ({
              siteUrl: w.siteId ? siteUrlForId(siteMap, w.siteId) : null,
              searchType: w.searchType ?? 'web',
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
        scope: w.siteId ? `${w.table}@${siteArg(siteUrlForId(siteMap, w.siteId))}` : w.table,
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
