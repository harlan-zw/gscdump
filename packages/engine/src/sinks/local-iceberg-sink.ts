/**
 * `LocalIcebergSink` — test `Sink`. Writes GSC fact rows into a REAL local
 * Apache Iceberg table: the POC stack (`apache/iceberg-rest-fixture` REST
 * catalog + MinIO), standing in for R2 Data Catalog + R2.
 *
 * Reproduces the *outcome* of a Cloudflare Pipeline sinking into the Iceberg
 * table — so a local e2e test exercises the exact format, partition spec, and
 * queries production will. It is NOT the prod write path (`PipelineSink` is).
 *
 * Write engine: PyIceberg, driven through a subprocess (`scripts/iceberg-writer.py`),
 * the same library the Phase-0 POC loader (`poc/iceberg/scripts/load_iceberg.py`)
 * used. Iceberg has no mature pure-JS writer; the subprocess is the test-only
 * seam.
 *
 * Ingest is append-only (design v5): there is no overwrite path.
 *
 * - `emit` → PyIceberg `table.append`.
 * - `close` → no-op; PyIceberg commits per call.
 *
 * The 5 fact tables are created on first write from {@link ICEBERG_SCHEMAS} —
 * the canonical schema is the only source of truth, never hand-listed.
 */

import type { IcebergTableName } from '../iceberg-schema'
import type { LocalIcebergSinkOptions, Sink, SinkCloseResult, SinkSlice, SinkWriteResult } from '../sink'
import type { Row } from '../storage'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ICEBERG_SCHEMAS } from '../iceberg-schema'

/** S3-compatible credentials for the warehouse (POC: MinIO). */
export interface LocalIcebergS3Config {
  /** S3 endpoint host (POC MinIO: `localhost:9100`). */
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
}

/** Full `LocalIcebergSink` options — extends the frozen contract options. */
export interface LocalIcebergSinkFullOptions extends LocalIcebergSinkOptions {
  /** S3 credentials for the warehouse. Defaults to the POC MinIO creds. */
  s3?: LocalIcebergS3Config
  /** Python interpreter. Defaults to `$GSCDUMP_ICEBERG_PYTHON` then `python3`. */
  python?: string
  /** Override the writer-script path. Defaults to `scripts/iceberg-writer.py`. */
  writerScript?: string
}

/** POC MinIO defaults (`docker-compose.iceberg.yml`). */
const POC_S3: LocalIcebergS3Config = {
  endpoint: 'localhost:9100',
  accessKeyId: 'poc',
  secretAccessKey: 'pocpocpoc',
  region: 'us-east-1',
}

interface WriterJob {
  op: 'emit' | 'close'
  catalogUri: string
  namespace: string
  warehouse: string
  s3: LocalIcebergS3Config
  table: string
  spec: unknown
  siteId: string
  searchType: string
  date: string
  rows: readonly Row[]
}

interface WriterResult {
  rowCount?: number
  error?: string
}

function resolveWriterScript(override?: string): string {
  if (override)
    return override
  // src/sinks/local-iceberg-sink.ts -> ../../scripts/iceberg-writer.py
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', 'scripts', 'iceberg-writer.py')
}

/** Run the PyIceberg writer subprocess for one job, return its parsed result. */
function runWriter(python: string, script: string, job: WriterJob): Promise<WriterResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      [script],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let parsed: WriterResult | undefined
        if (stdout.trim()) {
          try {
            parsed = JSON.parse(stdout) as WriterResult
          }
          catch {
            // fall through to the error path below
          }
        }
        if (parsed?.error) {
          reject(new Error(`LocalIcebergSink writer failed: ${parsed.error}`))
          return
        }
        if (err) {
          reject(new Error(
            `LocalIcebergSink writer process failed (${err.message})${stderr ? `: ${stderr}` : ''}`,
          ))
          return
        }
        if (!parsed) {
          reject(new Error(`LocalIcebergSink writer produced no parseable output: ${stdout || stderr}`))
          return
        }
        resolve(parsed)
      },
    )
    child.stdin?.end(JSON.stringify(job))
  })
}

export interface LocalIcebergSink extends Sink {
  /** The catalog namespace the 5 tables live under. */
  readonly namespace: string
}

/**
 * Create a `LocalIcebergSink` pointed at a local Iceberg REST catalog.
 *
 * Requires the POC docker stack (`poc/iceberg/docker-compose.iceberg.yml`)
 * running and a Python env with `pyiceberg` + `pyarrow` available. Tests that
 * use this sink must skip when the stack is unreachable.
 */
export function createLocalIcebergSink(options: LocalIcebergSinkFullOptions): LocalIcebergSink {
  const s3 = options.s3 ?? POC_S3
  const python = options.python ?? process.env.GSCDUMP_ICEBERG_PYTHON ?? 'python3'
  const script = resolveWriterScript(options.writerScript)

  function buildJob(op: 'emit', slice: SinkSlice, rows: readonly Row[]): WriterJob {
    return {
      op,
      catalogUri: options.catalogUri,
      namespace: options.namespace,
      warehouse: options.warehouse,
      s3,
      table: slice.table,
      spec: ICEBERG_SCHEMAS[slice.table],
      siteId: slice.ctx.siteId ?? '',
      searchType: slice.searchType,
      date: slice.date,
      rows,
    }
  }

  // Tables that received rows — PyIceberg commits each `emit`, so they are
  // all durable by `close()` time.
  const touched = new Set<IcebergTableName>()

  return {
    namespace: options.namespace,
    capabilities: { appendOnly: true },

    async emit(slice: SinkSlice, rows: readonly Row[]): Promise<SinkWriteResult> {
      if (rows.length === 0)
        return { rowCount: 0 }
      const res = await runWriter(python, script, buildJob('emit', slice, rows))
      touched.add(slice.table)
      return { rowCount: res.rowCount ?? 0 }
    },

    async close(): Promise<SinkCloseResult> {
      // PyIceberg commits per call — every emitted slice is already durable.
      return { flushed: [...touched], failed: [] }
    },
  }
}
