import type {
  DataSource,
  ManifestEntry,
  ManifestStore,
  ParquetCodec,
  WriteCtx,
} from './storage'
import { currentSchemaVersion } from './schema'
import { dayPartition, monthPartition, objectKey } from './storage'

const DAILY_PARTITION_RE = /^daily\/(\d{4}-\d{2}-\d{2})$/
const MONTHLY_PARTITION_RE = /^monthly\/(\d{4}-\d{2})$/

export interface CompactionDeps {
  dataSource: DataSource
  manifestStore: ManifestStore
  codec: ParquetCodec
}

export async function compactOlderThanImpl(
  deps: CompactionDeps,
  ctx: WriteCtx,
  days: number,
  now: number,
): Promise<void> {
  const cutoff = now - days * 86_400_000

  const candidates = await deps.manifestStore.listLive({
    userId: ctx.userId,
    siteId: ctx.siteId,
    table: ctx.table,
  })

  const byMonth = new Map<string, ManifestEntry[]>()
  for (const entry of candidates) {
    const dailyMatch = entry.partition.match(DAILY_PARTITION_RE)
    if (dailyMatch) {
      const date = dailyMatch[1]
      const dayStart = Date.parse(`${date}T00:00:00Z`)
      if (dayStart >= cutoff)
        continue
      const month = date.slice(0, 7)
      if (!byMonth.has(month))
        byMonth.set(month, [])
      byMonth.get(month)!.push(entry)
      continue
    }
    const monthlyMatch = entry.partition.match(MONTHLY_PARTITION_RE)
    if (monthlyMatch) {
      const month = monthlyMatch[1]
      const monthEnd = monthEndMs(month)
      if (monthEnd >= cutoff)
        continue
      if (!byMonth.has(month))
        byMonth.set(month, [])
      byMonth.get(month)!.push(entry)
    }
  }

  for (const [month, entries] of byMonth) {
    if (entries.length === 1 && entries[0].partition === monthPartition(month))
      continue

    const partition = monthPartition(month)
    await deps.manifestStore.withLock(
      { userId: ctx.userId, siteId: ctx.siteId, table: ctx.table, partition },
      async () => {
        const key = objectKey(ctx, ctx.table, partition, now)
        const { bytes, rowCount } = await deps.codec.compactRows(
          { table: ctx.table },
          entries.map(e => e.objectKey),
          key,
          deps.dataSource,
        )

        const newEntry: ManifestEntry = {
          userId: ctx.userId,
          siteId: ctx.siteId,
          table: ctx.table,
          partition,
          objectKey: key,
          rowCount,
          bytes,
          createdAt: now,
          schemaVersion: currentSchemaVersion(ctx.table),
        }
        await deps.manifestStore.registerVersion(newEntry, entries)
      },
    )
  }
}

export function enumeratePartitions(startDate: string, endDate: string): string[] {
  const out: string[] = []
  const [sy, sm, sd] = startDate.split('-').map(Number)
  const [ey, em, ed] = endDate.split('-').map(Number)
  const start = Date.UTC(sy, sm - 1, sd)
  const end = Date.UTC(ey, em - 1, ed)
  if (end < start)
    return out

  const seenMonths = new Set<string>()
  for (let t = start; t <= end; t += 86400_000) {
    const d = new Date(t)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    const isoDay = `${y}-${m}-${day}`
    const isoMonth = `${y}-${m}`
    out.push(dayPartition(isoDay))
    if (!seenMonths.has(isoMonth)) {
      seenMonths.add(isoMonth)
      out.push(monthPartition(isoMonth))
    }
  }
  return out
}

function monthEndMs(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return Date.UTC(y, m, 0, 23, 59, 59, 999)
}
