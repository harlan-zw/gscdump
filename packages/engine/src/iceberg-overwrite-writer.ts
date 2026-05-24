/**
 * Trailing-window Iceberg overwrite writer — the GSC-revision path (TODO P1.4).
 *
 * GSC restates clicks/impressions for weeks after its 3-day finalization lag.
 * The daily sync re-fetches the trailing window; those revised dates must
 * REPLACE the existing rows in the Iceberg table. Cloudflare Pipelines is
 * append-only, so `PipelineSink.overwriteSlice` delegates to this writer,
 * which performs a partition-level Iceberg `overwrite` (DELETE+INSERT of the
 * `site_id` + `search_type` + `date` partition) — one atomic Iceberg snapshot.
 *
 * RUNTIME DECISION — spike 2026-05-22
 * (`docs/plans/2026-05-22-overwrite-writer-spike.md`): **PyIceberg**, NOT
 * DuckDB Iceberg-write. The spike found DuckDB 1.5.3's Iceberg extension
 * raises `Delete from a partitioned table is not supported yet` against the
 * locked partition spec (`identity(site_id)` + `identity(search_type)` +
 * `month(date)`) — it can only `DELETE` predicates that match zero rows.
 * PyIceberg's `table.overwrite(df, overwrite_filter=…)` does the partitioned
 * overwrite cleanly (proven here and in POC Spike 5). A pure-JS Iceberg writer
 * with mature partition-overwrite does not exist.
 *
 * PyIceberg is Python, so prod runs it in a **Cloudflare Container**; this
 * module is the transport-agnostic client. Two backends ship:
 *
 * - `subprocessBackend` — spawns the PyIceberg writer script
 *   (`scripts/iceberg-writer.py`, shared with `LocalIcebergSink`). Used by
 *   local integration tests and by a Node-side scheduled job box.
 * - `httpBackend` — POSTs the job to a PyIceberg HTTP service (the Cloudflare
 *   Container in prod). The Worker holds no Python.
 *
 * Implements the frozen `SliceOverwriteWriter` contract from `./sink`.
 */

import type { Sink, SinkCloseResult, SinkSlice, SinkWriteResult, SliceOverwriteWriter } from './sink'
import type { Row } from './storage'
import process from 'node:process'
import { ICEBERG_SCHEMAS } from './iceberg-schema'

/** S3-compatible credentials for the Iceberg warehouse (R2 / MinIO). */
export interface IcebergS3Config {
  /** S3 endpoint host (POC MinIO: `localhost:9100`; prod: the R2 S3 endpoint). */
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
}

/** Connection details for the Iceberg REST catalog the writer targets. */
export interface IcebergCatalogConfig {
  /**
   * Iceberg REST catalog endpoint, e.g. `http://localhost:8181` (POC) or the
   *  R2 Data Catalog endpoint (prod).
   */
  catalogUri: string
  /** Catalog namespace the 5 fact tables live under, e.g. `gsc`. */
  namespace: string
  /** Warehouse identifier the catalog resolves table locations under. */
  warehouse: string
  /** S3-compatible object store backing the catalog. */
  s3: IcebergS3Config
}

/**
 * The JSON job wire-format shared with `scripts/iceberg-writer.py` — identical
 * to the shape `LocalIcebergSink` already emits, so one PyIceberg script backs
 * both the local sink and this writer. `op` is always `overwrite` here.
 */
export interface OverwriteJob {
  op: 'overwrite'
  catalogUri: string
  namespace: string
  warehouse: string
  s3: IcebergS3Config
  table: string
  spec: unknown
  siteId: string
  searchType: string
  date: string
  /** Data columns only — the script injects `site_id` / `search_type`. */
  rows: readonly Row[]
}

/** Result wire-format from the PyIceberg backend. */
export interface OverwriteJobResult {
  rowCount?: number
  error?: string
}

/**
 * A transport that executes one PyIceberg overwrite job and returns its
 * result. `subprocessBackend` and `httpBackend` are the two shipped
 * implementations; tests inject a fake.
 */
export type OverwriteBackend = (job: OverwriteJob) => Promise<OverwriteJobResult>

export interface IcebergOverwriteWriterOptions {
  catalog: IcebergCatalogConfig
  /** The transport that runs the PyIceberg job. */
  backend: OverwriteBackend
}

/**
 * The trailing-window Iceberg overwrite writer. Conforms to the frozen
 * `SliceOverwriteWriter` contract; `overwriteSlice` builds one PyIceberg
 * overwrite job per call and runs it through the configured backend.
 */
export interface IcebergOverwriteWriter extends SliceOverwriteWriter {
  /** Release any backend resources. Idempotent. */
  close: () => Promise<SinkCloseResult>
}

/**
 * Build a trailing-window Iceberg overwrite writer over the given backend.
 * Pure — all I/O is the backend's; the writer only shapes the job.
 */
export function createIcebergOverwriteWriter(
  opts: IcebergOverwriteWriterOptions,
): IcebergOverwriteWriter {
  const { catalog, backend } = opts

  async function overwriteSlice(slice: SinkSlice, rows: readonly Row[]): Promise<SinkWriteResult> {
    const siteId = slice.ctx.siteId
    if (!siteId)
      throw new Error('overwriteSlice: slice.ctx.siteId is required for the Iceberg partition key')

    const job: OverwriteJob = {
      op: 'overwrite',
      catalogUri: catalog.catalogUri,
      namespace: catalog.namespace,
      warehouse: catalog.warehouse,
      s3: catalog.s3,
      table: slice.table,
      spec: ICEBERG_SCHEMAS[slice.table],
      siteId,
      searchType: slice.searchType,
      date: slice.date,
      rows,
    }
    const res = await backend(job)
    if (res.error)
      throw new Error(`overwriteSlice: PyIceberg backend failed: ${res.error}`)
    return { rowCount: res.rowCount ?? rows.length }
  }

  return {
    overwriteSlice,
    async close() {
      return { flushed: [], failed: [] }
    },
  }
}

/** Options for the PyIceberg subprocess backend. */
export interface SubprocessBackendOptions {
  /** Python interpreter. Defaults to `$GSCDUMP_ICEBERG_PYTHON` then `python3`. */
  python?: string
  /**
   * Path to the PyIceberg writer script. Defaults to
   *  `<engine>/scripts/iceberg-writer.py`.
   */
  writerScript?: string
}

/**
 * Backend that runs the PyIceberg overwrite by spawning the shared writer
 * script (`scripts/iceberg-writer.py`). Node-only — used by local integration
 * tests and a Node-side scheduled job box. The script reads the job JSON on
 * stdin and writes `{rowCount}` / `{error}` on stdout.
 */
export function subprocessBackend(opts: SubprocessBackendOptions = {}): OverwriteBackend {
  return async (job) => {
    const { execFile } = await import('node:child_process')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const python = opts.python ?? process.env.GSCDUMP_ICEBERG_PYTHON ?? 'python3'
    const script = opts.writerScript
      ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'iceberg-writer.py')

    return new Promise<OverwriteJobResult>((resolve, reject) => {
      const child = execFile(
        python,
        [script],
        { maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          let parsed: OverwriteJobResult | undefined
          if (stdout.trim()) {
            try {
              parsed = JSON.parse(stdout) as OverwriteJobResult
            }
            catch {
              // fall through
            }
          }
          if (parsed) {
            resolve(parsed)
            return
          }
          reject(new Error(
            `iceberg overwrite subprocess produced no parseable output${
              err ? ` (${err.message})` : ''}${stderr ? `: ${stderr}` : ''}`,
          ))
        },
      )
      child.stdin?.end(JSON.stringify(job))
    })
  }
}

/** Options for the PyIceberg HTTP backend (the Cloudflare Container in prod). */
export interface HttpBackendOptions {
  /**
   * URL of the PyIceberg overwrite service — a POST endpoint accepting the
   *  `OverwriteJob` JSON and returning `OverwriteJobResult`.
   */
  endpoint: string
  /** Optional bearer token for the service. */
  token?: string
  /** Injectable fetch — defaults to the global. */
  fetch?: typeof fetch
}

/**
 * Backend that POSTs the overwrite job to a PyIceberg HTTP service — the
 * Cloudflare Container running `iceberg-writer.py` behind an HTTP shim. This
 * is the prod transport: the request-path Worker holds no Python and never
 * does an Iceberg metadata commit itself.
 */
export function httpBackend(opts: HttpBackendOptions): OverwriteBackend {
  const doFetch = opts.fetch ?? fetch
  return async (job) => {
    const res = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(job),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { error: `HTTP ${res.status}${body ? `: ${body}` : ''}` }
    }
    return (await res.json()) as OverwriteJobResult
  }
}

/**
 * Adapt an `IcebergOverwriteWriter` into a full `Sink` whose `emit` is also a
 * partition-overwrite — convenient for tests so a single Iceberg writer backs
 * both append and revision paths against the local stack. Prod keeps `emit`
 * on the Pipeline; only `overwriteSlice` delegates here.
 */
export function overwriteWriterAsSink(writer: IcebergOverwriteWriter): Sink & SliceOverwriteWriter {
  return {
    capabilities: { canOverwrite: true, appendOnly: false },
    emit: (slice, rows) => writer.overwriteSlice(slice, rows),
    overwriteSlice: (slice, rows) => writer.overwriteSlice(slice, rows),
    close: () => writer.close(),
  }
}
