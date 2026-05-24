/**
 * `PipelineSink` — prod `Sink`. Emits GSC fact rows to a Cloudflare Pipeline
 * Stream binding, which sinks them into the Iceberg table. Append-only.
 *
 * Pipelines cannot do an Iceberg `overwrite`, so the GSC-revision path
 * (`overwriteSlice`) is delegated to an external `SliceOverwriteWriter` (the
 * trailing-window Iceberg overwrite writer — TODO P1.4). `capabilities`
 * therefore reports `canOverwrite: false`, `appendOnly: true`.
 *
 * The Pipeline Stream binding's runtime surface is `send(records: object[])`.
 * The contract types it `unknown` to avoid a `@cloudflare/workers-types`
 * dependency; this file narrows it to {@link PipelineStreamBinding}. The
 * real binding is provisioned later (TODO P1) — build/test against a fake
 * binding that conforms to the same shape.
 */

import type {
  PipelineSinkOptions,
  Sink,
  SinkCloseResult,
  SinkSlice,
  SinkWriteResult,
  SliceOverwriteWriter,
} from '../sink'
import type { Row } from '../storage'

/**
 * The runtime shape of a Cloudflare Pipeline Stream binding `PipelineSink`
 * needs. `send` enqueues records onto the stream; one call per slice.
 */
export interface PipelineStreamBinding {
  send: (records: readonly Record<string, unknown>[]) => Promise<void>
}

/**
 * The wire record `PipelineSink` puts on the stream. The Pipeline's SQL
 * transform schematizes these into the Iceberg table; the partition identity
 * columns (`site_id`, `search_type`) are injected here so the transform never
 * has to reconstruct them.
 */
export type PipelineRecord = Row & {
  site_id: string
  search_type: string
  table: string
  date: string
}

function isStreamBinding(v: unknown): v is PipelineStreamBinding {
  return typeof v === 'object' && v !== null
    && typeof (v as { send?: unknown }).send === 'function'
}

/** Build the wire records for a slice — inject identity + routing columns. */
function toRecords(slice: SinkSlice, rows: readonly Row[]): PipelineRecord[] {
  const siteId = slice.ctx.siteId ?? ''
  return rows.map(r => ({
    ...r,
    site_id: siteId,
    search_type: slice.searchType,
    table: slice.table,
    date: slice.date,
  }))
}

export interface PipelineSink extends Sink, SliceOverwriteWriter {
  /** The `SliceOverwriteWriter` `overwriteSlice` is delegated to. */
  readonly overwriteWriter: SliceOverwriteWriter
}

/**
 * Create a `PipelineSink` over a Cloudflare Pipeline Stream binding.
 *
 * @throws if `options.stream` is not a `send`-shaped binding — fail fast at
 *   construction rather than on the first emit.
 */
export function createPipelineSink(options: PipelineSinkOptions): PipelineSink {
  if (!isStreamBinding(options.stream)) {
    throw new TypeError(
      'PipelineSink: `stream` must be a Cloudflare Pipeline Stream binding with a `send(records)` method',
    )
  }
  const stream: PipelineStreamBinding = options.stream
  const overwriteWriter = options.overwriteWriter

  return {
    overwriteWriter,
    capabilities: { canOverwrite: false, appendOnly: true },

    async emit(slice: SinkSlice, rows: readonly Row[]): Promise<SinkWriteResult> {
      if (rows.length === 0)
        return { rowCount: 0 }
      const records = toRecords(slice, rows)
      await stream.send(records)
      // Pipelines does not report bytes — leave `bytes` undefined.
      return { rowCount: records.length }
    },

    /**
     * Append-only sink: route the partition-overwrite to the external
     * trailing-window Iceberg overwrite writer, NOT the Pipeline Stream.
     */
    async overwriteSlice(slice: SinkSlice, rows: readonly Row[]): Promise<SinkWriteResult> {
      return overwriteWriter.overwriteSlice(slice, rows)
    },

    /**
     * Pipelines auto-flushes its own batches; there is no client-side buffer
     * to drain. No-op, idempotent.
     */
    async close(): Promise<SinkCloseResult> {
      return { flushed: [], failed: [] }
    },
  }
}
