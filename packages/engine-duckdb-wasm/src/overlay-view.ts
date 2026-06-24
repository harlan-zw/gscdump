/**
 * Browser-side recent-overlay merge-on-read SQL — shared by the OPFS attach path
 * (`opfs.ts`) and the in-memory buffer attach path (consumers'
 * `registerParquetView`).
 *
 * The lake serves every day it has; the overlay serves ONLY days the lake lacks
 * (`date NOT IN (SELECT DISTINCT date FROM lake)`), unioned with
 * `UNION ALL BY NAME`. This is the browser sibling of the server's
 * `overlayMergeEnvelope` (in gscdump.com); kept SEPARATE because the browser path
 * can read the lake once via a `MATERIALIZED` CTE (CPU-bound DuckDB-WASM, bounded
 * per-site buffers) where the server's many-s3-file reads prefer projection
 * pushdown over a re-scan.
 *
 * Both `lakeSelect` / `overlaySelect` must already expose a `date` column cast to
 * DATE (the overlay stores ISO strings; `SELECT * REPLACE (CAST(date AS DATE) AS
 * date)`), so `UNION ALL BY NAME` merges them type-uniformly.
 */

/**
 * The view BODY (no `CREATE VIEW` wrapper) merging a base lake relation and a
 * recent overlay. Returns null when neither side exists; the lake verbatim with
 * no overlay; the overlay verbatim with no lake (every recent row is wanted).
 *
 * `materializeLake` (default true): wrap the lake in a `MATERIALIZED` CTE so it is
 * scanned ONCE and reused for both the served rows and the anti-join date set — a
 * plain CTE inlines and re-scans the parquet, the dominant cost in DuckDB-WASM.
 * Set false to keep the streaming re-scan shape (lower peak memory, two scans).
 */
export function overlayViewBody(args: {
  lakeSelect: string | null
  overlaySelect: string | null
  materializeLake?: boolean
}): string | null {
  const { lakeSelect, overlaySelect } = args
  const materialize = args.materializeLake ?? true
  if (!lakeSelect && !overlaySelect)
    return null
  if (!overlaySelect)
    return lakeSelect
  if (!lakeSelect)
    return overlaySelect
  if (materialize) {
    return `WITH lake AS MATERIALIZED (${lakeSelect}), `
      + `lake_dates AS (SELECT DISTINCT date FROM lake) `
      + `SELECT * FROM lake `
      + `UNION ALL BY NAME `
      + `SELECT * FROM (${overlaySelect}) AS overlay WHERE overlay.date NOT IN (SELECT date FROM lake_dates)`
  }
  return `${lakeSelect} `
    + `UNION ALL BY NAME `
    + `SELECT * FROM (${overlaySelect}) AS overlay WHERE overlay.date NOT IN (SELECT DISTINCT date FROM (${lakeSelect}))`
}
