// R2 write-accumulator core: a thin orchestration layer around `RowAccumulator`
// that flushes per-(table, date) bucket via an injected `engine.writeDay` and
// surfaces host concerns (recovery queue, error log, manifest bust, post-flush
// hook) as callbacks. Hosts compose this with their D1/queue/drizzle wiring.

import type { Grain, Row, TableName } from '@gscdump/contracts'
import type { GscApiRow, RowAccumulator, RowAccumulatorOptions } from './ingest'
import type { SearchType, TenantCtx } from './storage'
import { createRowAccumulator } from './ingest'

export interface IngestAccumulatorEngine {
  writeDay: (scope: TenantCtx & { table: TableName, date: string, searchType?: SearchType }, rows: Row[]) => Promise<void>
  /**
   * Routed when the accumulator's `ctx.grain === 'hour'`. Same scope shape as
   * `writeDay`; `date` is the PT calendar day, rows carry `hour` + `date`.
   * Optional so hosts that never opt into hourly need not implement it.
   */
  writeHour?: (scope: TenantCtx & { table: TableName, date: string, searchType?: SearchType }, rows: Row[]) => Promise<void>
  setSyncState: (
    scope: TenantCtx & { table: TableName, date: string, searchType?: SearchType },
    state: 'done' | 'failed',
    info?: { error?: string },
  ) => Promise<void>
}

export interface IngestAccumulatorCtx {
  userId: string | number
  siteId: string
  searchType?: SearchType
  /**
   * Temporal granularity for this accumulator. `'day'` (default) routes
   * flushed buckets to `engine.writeDay`. `'hour'` routes to
   * `engine.writeHour` and requires the engine implementation to be set.
   */
  grain?: Grain
}

export interface IngestAccumulatorHooks {
  /**
   * Called once per (table, date) when the job must abandon in-memory rows
   *  (overflow or `hasMore` continuation). Host queues a forced re-sync from
   *  the source. Return true iff a recovery job was actually queued.
   */
  onRecover: (table: TableName, date: string) => Promise<boolean>
  /**
   * Called when an engine.writeDay fails or recovery itself errors. Host
   *  logs to its error sink (e.g. `r2_write_errors` D1 table).
   */
  onWriteError: (info: { table: TableName | null, date: string | null, error: unknown }) => Promise<void>
  /**
   * Called after a successful writeDay for a (table, date). Host typically
   *  busts the manifest cache here so the next read sees the new parquet.
   */
  onWritten?: (info: { table: TableName, date: string, rowCount: number }) => void | Promise<void>
  /**
   * Called once at end of `finalize`, only when at least one (table, date)
   *  actually landed. Host queues rollup rebuild + compaction.
   */
  onJobComplete?: (info: { flushed: number, rowsWritten: number }) => Promise<void>
}

export interface FinalizeOptions {
  /**
   * The GSC `hasMore` flag for the whole job. When true, in-memory buckets
   *  only reflect this job's slice; we re-queue forced single-day re-syncs
   *  via `onRecover` so R2 stays authoritative.
   */
  hasMore: boolean
}

export interface FinalizeResult {
  flushed: number
  recovered: number
  failed: number
  rowsWritten: number
}

export interface IngestAccumulator {
  push: (table: TableName, rows: readonly GscApiRow[]) => boolean
  finalize: (opts: FinalizeOptions) => Promise<FinalizeResult>
}

const NOOP_RESULT: FinalizeResult = { flushed: 0, recovered: 0, failed: 0, rowsWritten: 0 }

export interface CreateIngestAccumulatorOptions extends RowAccumulatorOptions {
  engine: IngestAccumulatorEngine
  ctx: IngestAccumulatorCtx
  hooks: IngestAccumulatorHooks
}

function scopeOf(ctx: IngestAccumulatorCtx, table: TableName, date: string): TenantCtx & { table: TableName, date: string, searchType?: SearchType } {
  return {
    userId: String(ctx.userId),
    siteId: ctx.siteId,
    table,
    date,
    ...(ctx.searchType !== undefined ? { searchType: ctx.searchType } : {}),
  }
}

export function createNoopIngestAccumulator(): IngestAccumulator {
  return {
    push() {
      return false
    },
    async finalize() {
      return NOOP_RESULT
    },
  }
}

export function createIngestAccumulator(opts: CreateIngestAccumulatorOptions): IngestAccumulator {
  const { engine, ctx, hooks, ...accOpts } = opts
  const acc: RowAccumulator = createRowAccumulator(accOpts)

  function reportHookFailure(hook: string, error: unknown): void {
    console.warn(`[gscdump/engine] ${hook} hook failed`, error)
  }

  async function notifyWriteError(info: Parameters<IngestAccumulatorHooks['onWriteError']>[0]): Promise<void> {
    try {
      await hooks.onWriteError(info)
    }
    catch (hookError) {
      reportHookFailure('onWriteError', hookError)
    }
  }

  async function writeOne(table: TableName, date: string, rows: Row[]): Promise<{ ok: true, rows: number } | { ok: false }> {
    const scope = scopeOf(ctx, table, date)
    const write = ctx.grain === 'hour'
      ? (engine.writeHour ?? (() => Promise.reject(new Error('ingest accumulator: grain=hour requires engine.writeHour'))))
      : engine.writeDay
    return write(scope, rows)
      .then(() => engine.setSyncState(scope, 'done'))
      .then(async () => {
        await hooks.onWritten?.({ table, date, rowCount: rows.length })
        return { ok: true as const, rows: rows.length }
      })
      .catch(async (err) => {
        await notifyWriteError({ table, date, error: err })
        return { ok: false as const }
      })
  }

  async function recover(table: TableName, date: string): Promise<boolean> {
    const scope = scopeOf(ctx, table, date)
    try {
      await engine.setSyncState(scope, 'failed', { error: 'mid-continuation-skip' })
    }
    catch (stateError) {
      await notifyWriteError({ table, date, error: stateError })
    }
    return hooks.onRecover(table, date).catch(async (err) => {
      await notifyWriteError({ table, date, error: err })
      return false
    })
  }

  return {
    push(table, rows) {
      return acc.push(table, rows)
    },
    async finalize({ hasMore }) {
      const overflowed = acc.overflowed
      const totalRows = acc.totalRows
      const buckets = acc.drain()

      if (overflowed || hasMore) {
        const tasks: Array<Promise<boolean>> = []
        for (const [table, byDate] of buckets) {
          for (const date of byDate.keys())
            tasks.push(recover(table, date))
        }
        const results = await Promise.all(tasks).catch(async (err) => {
          await notifyWriteError({ table: null, date: null, error: err })
          return [] as boolean[]
        })
        if (overflowed) {
          await notifyWriteError({
            table: null,
            date: null,
            error: new Error(`ingest accumulator overflow at ${totalRows} rows; recovering via forced re-sync`),
          })
        }
        return { flushed: 0, recovered: results.filter(Boolean).length, failed: 0, rowsWritten: 0 }
      }

      const writes: Array<Promise<{ ok: true, rows: number } | { ok: false }>> = []
      for (const [table, byDate] of buckets) {
        for (const [date, rows] of byDate)
          writes.push(writeOne(table, date, rows))
      }
      const outcomes = await Promise.all(writes)

      let flushed = 0
      let failed = 0
      let rowsWritten = 0
      for (const o of outcomes) {
        if (o.ok) {
          flushed++
          rowsWritten += o.rows
        }
        else {
          failed++
        }
      }

      if (flushed > 0 && hooks.onJobComplete) {
        try {
          await hooks.onJobComplete({ flushed, rowsWritten })
        }
        catch (hookError) {
          reportHookFailure('onJobComplete', hookError)
        }
      }

      return { flushed, recovered: 0, failed, rowsWritten }
    },
  }
}
