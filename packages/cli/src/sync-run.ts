// The sync-run record: one JSON file in the data dir that says whether a
// sync is running, how far it got, and whether it died. `sync --status`
// reads it, and a new sync refuses to start while another one is alive.

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/** A heartbeat older than this means the sync stopped without cleanup. */
export const SYNC_HEARTBEAT_STALE_MS = 2 * 60_000
const HEARTBEAT_INTERVAL_MS = 10_000

export type SyncRunOutcome = 'completed' | 'stopped' | 'failed' | 'interrupted'

export interface SyncRunRecord {
  pid: number
  startedAt: number
  heartbeatAt: number
  sites: string[]
  site?: string
  planned: number
  done: number
  finishedAt?: number
  outcome?: SyncRunOutcome
}

export type SyncRunStatus
  = | { kind: 'none' }
    | { kind: 'running', record: SyncRunRecord }
    | { kind: 'stale', record: SyncRunRecord, reason: 'process-gone' | 'no-heartbeat' }
    | { kind: 'finished', record: SyncRunRecord }

/** Classify a stored record. Pure: the caller supplies the clock and the pid probe. */
export function syncRunStatus(
  record: SyncRunRecord | undefined,
  probe: { now: number, isAlive: (pid: number) => boolean },
): SyncRunStatus {
  if (!record)
    return { kind: 'none' }
  if (record.finishedAt !== undefined)
    return { kind: 'finished', record }
  if (!probe.isAlive(record.pid))
    return { kind: 'stale', record, reason: 'process-gone' }
  if (probe.now - record.heartbeatAt > SYNC_HEARTBEAT_STALE_MS)
    return { kind: 'stale', record, reason: 'no-heartbeat' }
  return { kind: 'running', record }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function syncRunPath(dataDir: string): string {
  return path.join(dataDir, 'sync-run.json')
}

export async function readSyncRun(dataDir: string): Promise<SyncRunRecord | undefined> {
  const body = await fs.readFile(syncRunPath(dataDir), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  return body === undefined ? undefined : JSON.parse(body) as SyncRunRecord
}

async function writeSyncRun(dataDir: string, record: SyncRunRecord): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  const file = syncRunPath(dataDir)
  const temporary = `${file}.${record.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(record, null, 2), 'utf8')
  await fs.rename(temporary, file)
}

export interface SyncRun {
  readonly record: SyncRunRecord
  setSite: (site: string) => void
  addPlanned: (n: number) => void
  tick: (n?: number) => void
  /** Write the record now. Also runs on every heartbeat. */
  save: () => Promise<void>
  finish: (outcome: SyncRunOutcome) => Promise<void>
}

/**
 * Start a run record and a heartbeat that rewrites it. `onHeartbeat` runs on
 * the same timer, so callers can flush other state (the quota ledger) too.
 */
export async function startSyncRun(opts: {
  dataDir: string
  sites: string[]
  now?: () => number
  onHeartbeat?: () => Promise<void>
}): Promise<SyncRun> {
  const now = opts.now ?? Date.now
  const record: SyncRunRecord = { pid: process.pid, startedAt: now(), heartbeatAt: now(), sites: opts.sites, planned: 0, done: 0 }
  let writing: Promise<void> = Promise.resolve()
  const save = (): Promise<void> => {
    record.heartbeatAt = now()
    const snapshot = { ...record }
    writing = writing.then(() => writeSyncRun(opts.dataDir, snapshot))
    return writing
  }
  await save()
  const timer = setInterval(() => {
    void save().then(() => opts.onHeartbeat?.()).catch((error: Error) => {
      // A missed heartbeat only makes the run look stale sooner; say so and go on.
      process.stderr.write(`gscdump: could not update the sync-run record: ${error.message}\n`)
    })
  }, HEARTBEAT_INTERVAL_MS)
  timer.unref()

  return {
    record,
    setSite(site) {
      record.site = site
    },
    addPlanned(n) {
      record.planned += n
    },
    tick(n = 1) {
      record.done += n
    },
    save,
    async finish(outcome) {
      clearInterval(timer)
      record.finishedAt = now()
      record.outcome = outcome
      await save()
    },
  }
}
