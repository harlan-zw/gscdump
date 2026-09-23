// Pure mapping and scheduling for URL Inspection records. `inspect`
// and `sync` share it, so both write the same record shape to the store.

import type { InspectionVerdict, ScheduleState } from '@gscdump/engine'
import type { InspectionRecord } from '@gscdump/engine/entities'
import type { UrlInspectionResult } from 'gscdump/indexing'
import { inspectionPolicy } from '@gscdump/engine'

/** Google allows 2,000 URL Inspection calls per property per day. */
export const INSPECTION_QPD_PER_PROPERTY = 2000

const DAY_MS = 24 * 60 * 60 * 1000

// A change on any of these fields resets the unchanged streak.
const STATE_FIELDS = [
  'indexStatus',
  'coverageState',
  'robotsTxtState',
  'indexingState',
  'pageFetchState',
  'googleCanonical',
] as const satisfies ReadonlyArray<keyof InspectionRecord>

function verdictOf(indexStatus: string | undefined): InspectionVerdict {
  return indexStatus === 'PASS' || indexStatus === 'FAIL' ? indexStatus : 'NEUTRAL'
}

/** Schedule state of a stored record. Records written without one get the policy default from their inspection time. */
export function scheduleOf(record: InspectionRecord): ScheduleState {
  if (record.raw?.schedule)
    return record.raw.schedule
  const at = Date.parse(record.inspectedAt)
  return inspectionPolicy(verdictOf(record.indexStatus)).initial(Number.isFinite(at) ? at : 0)
}

/**
 * Map one URL Inspection response to the stored record. When `previous` is
 * given, the schedule continues from it; otherwise it starts fresh.
 */
export function toInspectionRecord(input: {
  url: string
  result: UrlInspectionResult | undefined
  inspectedAt: Date
  previous?: InspectionRecord
}): InspectionRecord {
  const { url, result, inspectedAt, previous } = input
  const indexStatus = result?.indexStatusResult
  const record: InspectionRecord = {
    url,
    inspectedAt: inspectedAt.toISOString(),
    indexStatus: indexStatus?.verdict ?? undefined,
    lastCrawlTime: indexStatus?.lastCrawlTime ?? undefined,
    googleCanonical: indexStatus?.googleCanonical ?? undefined,
    userCanonical: indexStatus?.userCanonical ?? undefined,
    coverageState: indexStatus?.coverageState ?? undefined,
    robotsTxtState: indexStatus?.robotsTxtState ?? undefined,
    indexingState: indexStatus?.indexingState ?? undefined,
    pageFetchState: indexStatus?.pageFetchState ?? undefined,
    mobileUsabilityVerdict: result?.mobileUsabilityResult?.verdict ?? undefined,
    richResultsVerdict: result?.richResultsResult?.verdict ?? undefined,
  }
  const policy = inspectionPolicy(verdictOf(record.indexStatus))
  const at = inspectedAt.getTime()
  const schedule = previous
    ? policy.observe(scheduleOf(previous), {
        changed: STATE_FIELDS.some(field => (previous[field] ?? null) !== (record[field] ?? null)),
        at,
      })
    : policy.initial(at)
  record.raw = { ...(result as Record<string, unknown> | undefined), schedule }
  return record
}

/** Newest record per URL. */
export function latestByUrl(records: readonly InspectionRecord[]): Map<string, InspectionRecord> {
  const latest = new Map<string, InspectionRecord>()
  for (const record of records) {
    const prior = latest.get(record.url)
    if (!prior || record.inspectedAt > prior.inspectedAt)
      latest.set(record.url, record)
  }
  return latest
}

export interface InspectionPlan {
  /** URLs to inspect this run, in priority order. */
  urls: string[]
  /** Due URLs left for a later run. */
  deferred: number
  /** Calls this run may still make under the daily quota. */
  quotaLeft: number
}

/**
 * Pick the URLs due for inspection. Never-inspected URLs come first, in
 * candidate order. Then come due URLs, oldest schedule first. The budget is
 * the smaller of `limit` and the quota left after the last 24 hours of calls.
 */
export function planInspections(input: {
  candidates: readonly string[]
  history: readonly InspectionRecord[]
  now: Date
  limit: number
}): InspectionPlan {
  const now = input.now.getTime()
  const since = now - DAY_MS
  const usedToday = input.history.filter((record) => {
    const at = Date.parse(record.inspectedAt)
    return at > since && at <= now
  }).length
  const quotaLeft = Math.max(0, INSPECTION_QPD_PER_PROPERTY - usedToday)
  const latest = latestByUrl(input.history)

  const fresh: string[] = []
  const due: Array<{ url: string, nextAt: number }> = []
  for (const url of new Set(input.candidates)) {
    const record = latest.get(url)
    if (!record) {
      fresh.push(url)
      continue
    }
    const schedule = scheduleOf(record)
    if (inspectionPolicy(verdictOf(record.indexStatus)).isDue(schedule, now))
      due.push({ url, nextAt: schedule.nextAt })
  }
  due.sort((a, b) => a.nextAt - b.nextAt)
  const ordered = [...fresh, ...due.map(entry => entry.url)]
  const budget = Math.max(0, Math.min(input.limit, quotaLeft))
  return {
    urls: ordered.slice(0, budget),
    deferred: Math.max(0, ordered.length - budget),
    quotaLeft,
  }
}
