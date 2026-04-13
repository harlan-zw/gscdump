import type {
  DataSource,
  ManifestEntry,
  ManifestStore,
  ParquetCodec,
  Row,
  WriteCtx,
} from './storage'
import { dayPartition, monthPartition, objectKey } from './storage'

const MONTH_RE = /^\d{4}-\d{2}$/

export interface CompactionDeps {
  dataSource: DataSource
  manifestStore: ManifestStore
  codec: ParquetCodec
}

export async function compactDayImpl(
  deps: CompactionDeps,
  ctx: WriteCtx,
  shards: ManifestEntry[],
  now: number,
): Promise<void> {
  if (shards.length === 0)
    return
  if (shards.length === 1)
    return

  const partitions = new Set(shards.map(s => s.partition))
  if (partitions.size !== 1)
    throw new Error(`compactDay requires shards from one partition, got ${partitions.size}`)
  const partition = shards[0].partition

  const allRows: Row[] = []
  for (const shard of shards) {
    const bytes = await deps.dataSource.read(shard.objectKey)
    const decoded = await deps.codec.decode(bytes, ctx.table)
    for (const r of decoded) allRows.push(r)
  }

  const merged = await deps.codec.encode(ctx.table, allRows)
  const key = objectKey(ctx, ctx.table, partition, now)
  await deps.dataSource.write(key, merged)

  const entry: ManifestEntry = {
    userId: ctx.userId,
    siteId: ctx.siteId,
    table: ctx.table,
    partition,
    objectKey: key,
    rowCount: allRows.length,
    bytes: merged.byteLength,
    createdAt: now,
  }
  await deps.manifestStore.registerVersion(entry, shards)
}

export async function compactMonthImpl(
  deps: CompactionDeps,
  ctx: WriteCtx,
  month: string,
  now: number,
): Promise<void> {
  if (!MONTH_RE.test(month))
    throw new Error(`compactMonth expects YYYY-MM, got ${month}`)

  const dailyPartitions = daysInMonth(month).map(dayPartition)
  const existingMonthly = monthPartition(month)

  const candidates = await deps.manifestStore.listLive({
    userId: ctx.userId,
    siteId: ctx.siteId,
    table: ctx.table,
    partitions: [...dailyPartitions, existingMonthly],
  })

  if (candidates.length === 0)
    return

  const allRows: Row[] = []
  for (const entry of candidates) {
    const bytes = await deps.dataSource.read(entry.objectKey)
    const decoded = await deps.codec.decode(bytes, ctx.table)
    for (const r of decoded) allRows.push(r)
  }

  const merged = await deps.codec.encode(ctx.table, allRows)
  const key = objectKey(ctx, ctx.table, existingMonthly, now)
  await deps.dataSource.write(key, merged)

  const entry: ManifestEntry = {
    userId: ctx.userId,
    siteId: ctx.siteId,
    table: ctx.table,
    partition: existingMonthly,
    objectKey: key,
    rowCount: allRows.length,
    bytes: merged.byteLength,
    createdAt: now,
  }
  await deps.manifestStore.registerVersion(entry, candidates)
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

function daysInMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const out: string[] = []
  for (let d = 1; d <= last; d++) {
    out.push(`${month}-${String(d).padStart(2, '0')}`)
  }
  return out
}
