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

import type { Sink, SinkCloseResult, SinkSlice, SinkWriteResult, SliceOverwriteWriter } from '../sink'
import type { Row } from '../storage'
import type { IcebergS3Config } from './schema'
import { resolvePyIcebergPython, runPyIcebergWriter } from './pyiceberg-runtime'
import { assertIcebergTable, ICEBERG_SCHEMAS } from './schema'

/** Connection details for the Iceberg REST catalog the writer targets. */
export interface OverwriteWriterCatalogConfig {
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
  /** Bearer token for a token-authed REST catalog (R2 Data Catalog). */
  catalogToken?: string
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

/**
 * Per-site delete job — removes EVERY row for one `siteId` across a whole
 * table (all dates / search types). Recovery op for clearing a corrupt site
 * (e.g. a cross-run append double) from a shared per-team shard before a clean
 * re-backfill, without touching sibling sites. Carries no rows. `siteId` is a
 * `number` for an INT-encoded shard, a `string` for STRING encoding.
 */
export interface DeleteJob {
  op: 'delete'
  catalogUri: string
  namespace: string
  warehouse: string
  s3: IcebergS3Config
  /** Bearer token for a token-authed REST catalog (R2 Data Catalog). */
  catalogToken?: string
  table: string
  siteId: string | number
}

/** Any job the shared PyIceberg backend can execute. */
export type PyIcebergJob = OverwriteJob | DeleteJob

/** Result wire-format from the PyIceberg backend. */
export interface OverwriteJobResult {
  /** Rows written (emit/overwrite) or removed (delete). */
  rowCount?: number
  error?: string
}

/**
 * A transport that executes one PyIceberg job and returns its result.
 * `subprocessBackend` and `httpBackend` are the two shipped implementations;
 * tests inject a fake. The param is the `OverwriteJob | DeleteJob` union, so a
 * backend value is still assignable where the narrower `OverwriteBackend` is
 * expected (a wider-param function accepts the narrower call).
 */
export type OverwriteBackend = (job: PyIcebergJob) => Promise<OverwriteJobResult>

export interface IcebergOverwriteWriterOptions {
  catalog: OverwriteWriterCatalogConfig
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

    // Guard the `ICEBERG_SCHEMAS[slice.table]` lookup: `slice.table` is typed
    // `IcebergTableName`, but a runtime caller can pass a non-canonical name
    // (the lookup would then yield `undefined`, writing a corrupt spec).
    const table = assertIcebergTable(slice.table)

    const job: OverwriteJob = {
      op: 'overwrite',
      catalogUri: catalog.catalogUri,
      namespace: catalog.namespace,
      warehouse: catalog.warehouse,
      s3: catalog.s3,
      table,
      spec: ICEBERG_SCHEMAS[table],
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
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const python = resolvePyIcebergPython(opts.python)
    const script = opts.writerScript
      ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'iceberg-writer.py')

    return runPyIcebergWriter<OverwriteJobResult>({
      python,
      script,
      job,
      label: 'iceberg overwrite subprocess',
      processErrorAsParseFailure: true,
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

/** Per-table outcome of a {@link deleteSiteFromShard} run. */
export interface DeleteSiteResult {
  table: string
  /** Rows removed, when the backend reported a count. */
  rowCount?: number
  /** Present when this table's delete failed; the sweep continues regardless. */
  error?: string
}

/**
 * Remove every row for one `siteId` from a per-team Iceberg shard, across the
 * given tables. Recovery op: clear a corrupt site (e.g. a cross-run append
 * double) before a clean re-backfill, leaving sibling sites in the shared shard
 * untouched. `site_id` is an identity partition column, so PyIceberg prunes
 * whole data files (no row-level delete files).
 *
 * Runs SEQUENTIALLY (one commit per table at a time) so the per-table catalog
 * commit-rate ceiling is never tripped. A table failure is captured in its
 * result row, not thrown — the sweep always attempts every table so a partial
 * failure is visible and re-runnable (delete is idempotent: re-deleting an
 * already-empty site is a no-op).
 */
export async function deleteSiteFromShard(args: {
  catalog: OverwriteWriterCatalogConfig
  backend: OverwriteBackend
  siteId: string | number
  tables: readonly string[]
}): Promise<DeleteSiteResult[]> {
  const { catalog, backend, siteId, tables } = args
  const results: DeleteSiteResult[] = []
  for (const table of tables) {
    const job: DeleteJob = {
      op: 'delete',
      catalogUri: catalog.catalogUri,
      namespace: catalog.namespace,
      warehouse: catalog.warehouse,
      s3: catalog.s3,
      ...(catalog.catalogToken ? { catalogToken: catalog.catalogToken } : {}),
      table,
      siteId,
    }
    const res: OverwriteJobResult = await backend(job).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
    results.push(res.error ? { table, error: res.error } : { table, rowCount: res.rowCount })
  }
  return results
}
