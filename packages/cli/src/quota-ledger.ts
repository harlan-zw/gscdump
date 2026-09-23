// One model for Google API quotas. Every GSC call path asks the ledger for
// quota before it calls Google, and tells the ledger when Google refuses.
// Usage persists per (api, Site, PST day) in the data dir, so separate runs
// and separate commands share one daily budget.
//
// The decision logic is pure: `reserveQuota` and `recordQuotaOutcome` take a
// state and return a new one. `openQuotaLedger` keeps that state in memory
// and merges it into `quota-ledger.json` on `flush`.

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { getNextPstMidnight, getPstDate } from 'gscdump/dates'
import { classifyError } from 'gscdump/errors'

export type QuotaApi = 'searchAnalytics' | 'urlInspection' | 'indexing'

export interface QuotaCap {
  /** Calls per PST day. Undefined when Google publishes no daily cap. */
  perDay?: number
  /** Calls per minute. The request pacer enforces it. */
  perMinute: number
  /** Google counts `project` quotas across every Site of the Google Cloud project. */
  scope: 'site' | 'project'
}

/**
 * Published Google caps. Search Analytics also has an unpublished load
 * quota; the ledger learns it from refusals instead of from a number.
 */
export const QUOTA_CAPS: Record<QuotaApi, QuotaCap> = {
  searchAnalytics: { perMinute: 1200, scope: 'site' },
  urlInspection: { perDay: 2000, perMinute: 600, scope: 'site' },
  // Indexing API defaults: 200 publish calls a day, 380 calls a minute.
  indexing: { perDay: 200, perMinute: 380, scope: 'project' },
}

// Search Analytics refusals are short-term: the per-minute limit, or a load
// quota that Google measures in 10 minute chunks. The ledger waits a little
// longer than one chunk, then lets the next run try again.
const SHORT_TERM_BLOCK_MS: Record<'perMinute' | 'load', number> = {
  perMinute: 60_000,
  load: 15 * 60_000,
}

export interface QuotaUsage {
  api: QuotaApi
  /** The Site, or `*` for a project-wide cap. */
  site: string
  /** PST reporting day, YYYY-MM-DD. */
  day: string
  used: number
  /** Epoch ms until which Google refuses calls. */
  blockedUntil?: number
  reason?: string
}

export interface QuotaLedgerState {
  version: 1
  usage: QuotaUsage[]
}

export type QuotaDecision
  = | { kind: 'granted', n: number }
    | { kind: 'partial', n: number, resetsAt: number }
    | { kind: 'exhausted', resetsAt: number, reason: string }

export type QuotaOutcome
  /** Google refused the call for quota reasons. */
  = | { kind: 'refused', reason: string }
  /** Reserved calls that were not made. They go back to the budget. */
    | { kind: 'unused', n: number }

export interface QuotaStatus {
  api: QuotaApi
  site: string
  used: number
  perDay?: number
  blocked?: { until: number, reason: string }
}

export function emptyLedgerState(): QuotaLedgerState {
  return { version: 1, usage: [] }
}

function siteKey(api: QuotaApi, site: string): string {
  return QUOTA_CAPS[api].scope === 'project' ? '*' : site
}

function findUsage(state: QuotaLedgerState, api: QuotaApi, site: string, day: string): QuotaUsage | undefined {
  return state.usage.find(entry => entry.api === api && entry.site === site && entry.day === day)
}

function withUsage(state: QuotaLedgerState, next: QuotaUsage): QuotaLedgerState {
  const rest = state.usage.filter(entry => !(entry.api === next.api && entry.site === next.site && entry.day === next.day))
  return { version: 1, usage: [...rest, next] }
}

/** The block in force for an api and Site, from any day's entry. */
function activeBlock(state: QuotaLedgerState, api: QuotaApi, site: string, now: number): { until: number, reason: string } | undefined {
  let block: { until: number, reason: string } | undefined
  for (const entry of state.usage) {
    if (entry.api !== api || entry.site !== site || entry.blockedUntil === undefined || entry.blockedUntil <= now)
      continue
    if (!block || entry.blockedUntil > block.until)
      block = { until: entry.blockedUntil, reason: entry.reason ?? 'quota' }
  }
  return block
}

/** Ask for `n` calls. A grant counts as used at once. */
export function reserveQuota(
  state: QuotaLedgerState,
  input: { api: QuotaApi, site: string, n: number, now: Date },
): { decision: QuotaDecision, state: QuotaLedgerState } {
  const site = siteKey(input.api, input.site)
  const now = input.now.getTime()
  const block = activeBlock(state, input.api, site, now)
  if (block)
    return { decision: { kind: 'exhausted', resetsAt: block.until, reason: block.reason }, state }

  const day = getPstDate(input.now)
  const usage = findUsage(state, input.api, site, day) ?? { api: input.api, site, day, used: 0 }
  const cap = QUOTA_CAPS[input.api].perDay
  const left = cap === undefined ? input.n : Math.max(0, cap - usage.used)
  if (left <= 0) {
    return {
      decision: { kind: 'exhausted', resetsAt: getNextPstMidnight(input.now), reason: `${cap} calls a day` },
      state,
    }
  }
  const n = Math.min(input.n, left)
  const decision: QuotaDecision = n < input.n
    ? { kind: 'partial', n, resetsAt: getNextPstMidnight(input.now) }
    : { kind: 'granted', n }
  return { decision, state: withUsage(state, { ...usage, used: usage.used + n }) }
}

/** How long a refusal blocks the api. Daily caps reset at PST midnight. */
export function blockUntil(api: QuotaApi, reason: string, now: Date): number {
  if (api === 'searchAnalytics') {
    const perMinute = /qps|per minute|rate limit|ratelimit/i.test(reason)
    return now.getTime() + SHORT_TERM_BLOCK_MS[perMinute ? 'perMinute' : 'load']
  }
  if (/per minute|qps/i.test(reason))
    return now.getTime() + SHORT_TERM_BLOCK_MS.perMinute
  return getNextPstMidnight(now)
}

export function recordQuotaOutcome(
  state: QuotaLedgerState,
  input: { api: QuotaApi, site: string, outcome: QuotaOutcome, now: Date },
): QuotaLedgerState {
  const site = siteKey(input.api, input.site)
  const day = getPstDate(input.now)
  const usage = findUsage(state, input.api, site, day) ?? { api: input.api, site, day, used: 0 }
  if (input.outcome.kind === 'unused')
    return withUsage(state, { ...usage, used: Math.max(0, usage.used - input.outcome.n) })
  return withUsage(state, {
    ...usage,
    blockedUntil: blockUntil(input.api, input.outcome.reason, input.now),
    reason: input.outcome.reason,
  })
}

export function quotaStatus(state: QuotaLedgerState, input: { api: QuotaApi, site: string, now: Date }): QuotaStatus {
  const site = siteKey(input.api, input.site)
  const usage = findUsage(state, input.api, site, getPstDate(input.now))
  const block = activeBlock(state, input.api, site, input.now.getTime())
  return {
    api: input.api,
    site,
    used: usage?.used ?? 0,
    ...(QUOTA_CAPS[input.api].perDay !== undefined ? { perDay: QUOTA_CAPS[input.api].perDay } : {}),
    ...(block ? { blocked: block } : {}),
  }
}

/** Add `n` calls (negative to give calls back) to today's usage, ignoring caps. */
function addUsage(state: QuotaLedgerState, input: { api: QuotaApi, site: string, n: number, now: Date }): QuotaLedgerState {
  const site = siteKey(input.api, input.site)
  const day = getPstDate(input.now)
  const usage = findUsage(state, input.api, site, day) ?? { api: input.api, site, day, used: 0 }
  return withUsage(state, { ...usage, used: usage.used + input.n })
}

/** Keep today and yesterday (PST). Older days no longer affect any decision. */
export function pruneLedger(state: QuotaLedgerState, now: Date): QuotaLedgerState {
  const today = getPstDate(now)
  const keepFrom = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  const at = now.getTime()
  return {
    version: 1,
    usage: state.usage.filter(entry => entry.day >= keepFrom || (entry.blockedUntil ?? 0) > at),
  }
}

/** Merge a delta into a newer state from disk: usage adds up, the later block wins. */
export function mergeLedger(base: QuotaLedgerState, delta: QuotaLedgerState): QuotaLedgerState {
  let merged = base
  for (const entry of delta.usage) {
    const prior = findUsage(merged, entry.api, entry.site, entry.day)
    const blockedUntil = Math.max(prior?.blockedUntil ?? 0, entry.blockedUntil ?? 0)
    const reason = (entry.blockedUntil ?? 0) >= (prior?.blockedUntil ?? 0) ? entry.reason : prior?.reason
    merged = withUsage(merged, {
      api: entry.api,
      site: entry.site,
      day: entry.day,
      used: Math.max(0, (prior?.used ?? 0) + entry.used),
      ...(blockedUntil > 0 ? { blockedUntil } : {}),
      ...(reason ? { reason } : {}),
    })
  }
  return merged
}

/**
 * The quota reason of a Google error, or undefined when the error is not a
 * quota refusal. A 429, or a 403 with a quota reason, is a quota refusal.
 */
export function parseQuotaRefusal(error: unknown): string | undefined {
  const classified = classifyError(error)
  if (classified.kind !== 'rate-limited')
    return undefined
  return googleErrorMessage(error)
}

/** Google's own error message when the response carries one, else the error message. */
export function googleErrorMessage(error: unknown): string {
  const data = (error as { data?: { error?: { message?: unknown, code?: unknown } } } | null)?.data
  const message = data?.error?.message
  const status = (error as { status?: unknown, statusCode?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status
  if (typeof message === 'string' && message.length > 0)
    return typeof status === 'number' ? `${status} ${message}` : message
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Effectful shell
// ---------------------------------------------------------------------------

export interface QuotaLedger {
  reserve: (api: QuotaApi, site: string, n: number) => QuotaDecision
  record: (api: QuotaApi, site: string, outcome: QuotaOutcome) => void
  status: (api: QuotaApi, site: string) => QuotaStatus
  /** Merge this process's changes into the ledger file. */
  flush: () => Promise<void>
}

export function quotaLedgerPath(dataDir: string): string {
  return path.join(dataDir, 'quota-ledger.json')
}

function parseLedgerState(value: unknown): QuotaLedgerState {
  const usage = (value as { version?: unknown, usage?: unknown } | null)?.usage
  if ((value as { version?: unknown } | null)?.version !== 1 || !Array.isArray(usage))
    throw new Error('Quota ledger has an unknown format. Delete quota-ledger.json in the data dir to reset it.')
  return {
    version: 1,
    usage: usage.filter((entry): entry is QuotaUsage =>
      typeof entry === 'object' && entry !== null
      && typeof entry.api === 'string' && entry.api in QUOTA_CAPS
      && typeof entry.site === 'string' && typeof entry.day === 'string' && typeof entry.used === 'number'),
  }
}

export async function readLedgerState(file: string): Promise<QuotaLedgerState> {
  const body = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  return body === undefined ? emptyLedgerState() : parseLedgerState(JSON.parse(body))
}

async function writeLedgerState(file: string, state: QuotaLedgerState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(state), 'utf8')
  await fs.rename(temporary, file)
}

export async function openQuotaLedger(opts: { dataDir: string, now?: () => Date }): Promise<QuotaLedger> {
  const file = quotaLedgerPath(opts.dataDir)
  const now = opts.now ?? (() => new Date())
  let state = pruneLedger(await readLedgerState(file), now())
  // Changes since the last flush, merged into the file so parallel commands add up.
  let delta = emptyLedgerState()
  // The heartbeat and the post-sync flush can overlap. Serialize them like
  // sync-run's save queue, so each merge lands on the previous write and no
  // delta is lost.
  let flushes: Promise<void> = Promise.resolve()
  const flush = (): Promise<void> => {
    const next = flushes.then(async () => {
      const onDisk = await readLedgerState(file)
      state = pruneLedger(mergeLedger(onDisk, delta), now())
      delta = emptyLedgerState()
      await writeLedgerState(file, state)
    })
    // A failed flush must not poison later ones; the caller still sees the error.
    flushes = next.catch(() => {})
    return next
  }

  return {
    reserve(api, site, n) {
      const at = now()
      const result = reserveQuota(state, { api, site, n, now: at })
      state = result.state
      if (result.decision.kind !== 'exhausted')
        delta = addUsage(delta, { api, site, n: result.decision.n, now: at })
      return result.decision
    },
    record(api, site, outcome) {
      const at = now()
      state = recordQuotaOutcome(state, { api, site, outcome, now: at })
      delta = outcome.kind === 'unused'
        ? addUsage(delta, { api, site, n: -outcome.n, now: at })
        : recordQuotaOutcome(delta, { api, site, outcome, now: at })
    },
    status(api, site) {
      return quotaStatus(state, { api, site, now: now() })
    },
    flush,
  }
}
