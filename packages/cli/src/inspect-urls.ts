// Targeted URL Inspection: pace calls under Google's per-minute limit and
// stop at the first quota error, so the caller keeps every finished result.

import type { UrlInspectionResult } from 'gscdump/indexing'
import { classifyError } from 'gscdump/errors'
import { describeInspectionError, URL_INSPECTION_QUOTA } from 'gscdump/indexing'

// One call starts at most every 120 ms: 500 per minute, under Google's 600.
export const INSPECTION_INTERVAL_MS = 120

export type InspectOutcome
  = | { kind: 'inspected', url: string, result: UrlInspectionResult | undefined }
    | { kind: 'failed', url: string, error: string }

export interface InspectRun {
  outcomes: InspectOutcome[]
  /** Set when a quota error stopped the run before every URL was tried. */
  stopped: { reason: string, remaining: number } | null
}

export interface InspectUrlsInput {
  urls: readonly string[]
  /** The one call path to Google. Every inspection goes through it. */
  inspect: (url: string) => Promise<UrlInspectionResult | undefined>
  /** URLs this returns false for fail without an API call. */
  inProperty: (url: string) => boolean
  /** Runs after each outcome, before the next call, so a stop keeps saved work. */
  onOutcome: (outcome: InspectOutcome) => Promise<void>
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Refuse a run that would use more than one day of the property's quota. */
export function checkInspectionBatch(urls: readonly string[]): { kind: 'ok' } | { kind: 'too-many', message: string } {
  if (urls.length <= URL_INSPECTION_QUOTA.perDay)
    return { kind: 'ok' }
  const perDay = URL_INSPECTION_QUOTA.perDay.toLocaleString('en-US')
  return {
    kind: 'too-many',
    message: `You passed ${urls.length.toLocaleString('en-US')} URLs. Google allows ${perDay} URL inspections per day for each property. Inspect at most ${perDay} URLs in one run.`,
  }
}

export async function inspectUrls(input: InspectUrlsInput): Promise<InspectRun> {
  const intervalMs = input.intervalMs ?? INSPECTION_INTERVAL_MS
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = input.now ?? Date.now
  const outcomes: InspectOutcome[] = []
  let lastStart: number | null = null

  for (let i = 0; i < input.urls.length; i++) {
    const url = input.urls[i]!
    if (!input.inProperty(url)) {
      const outcome: InspectOutcome = { kind: 'failed', url, error: 'The URL is outside this Site.' }
      outcomes.push(outcome)
      await input.onOutcome(outcome)
      continue
    }
    if (lastStart !== null) {
      const wait = lastStart + intervalMs - now()
      if (wait > 0)
        await sleep(wait)
    }
    lastStart = now()
    const settled = await input.inspect(url).then(
      result => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (!settled.ok && classifyError(settled.error).kind === 'rate-limited')
      return { outcomes, stopped: { reason: describeInspectionError(settled.error), remaining: input.urls.length - i } }
    const outcome: InspectOutcome = settled.ok
      ? { kind: 'inspected', url, result: settled.result }
      : { kind: 'failed', url, error: describeInspectionError(settled.error) }
    outcomes.push(outcome)
    await input.onOutcome(outcome)
  }
  return { outcomes, stopped: null }
}
