/**
 * Archetype → DuckDB SQL compiler.
 *
 * Compiles the 10 typed `ArchetypeQuery` shapes (`@gscdump/sdk`) into SQL that
 * runs against OPFS-attached parquet views. This is the BROWSER executor: every
 * archetype with execution class `r2-sql`, `r2-sql-resolved`, or `duckdb` can
 * run locally against attached views — DuckDB-WASM is a dialect superset of R2
 * SQL and has the window functions R2 SQL lacks.
 *
 * `aux-cloud-only` (archetype 10) is NOT compiled — it has no Iceberg table and
 * is always cloud-routed; calling the compiler with it throws.
 *
 * The five fact-table views are named by their Iceberg table name (`pages`,
 * `queries`, `countries`, `page_queries`, `dates`). The compiler picks the
 * right view per archetype from the dimensions it touches. The `dates` table
 * carries true site totals plus a device breakdown pivoted into wide columns
 * (`clicks_desktop` etc.); date-only and device archetypes read it.
 */

import type { ArchetypeQuery } from '@gscdump/sdk'

/** A compiled, parameterised statement. */
export interface CompiledArchetypeSql {
  sql: string
  params: unknown[]
  /** The fact-table view the query reads. */
  table: string
}

/** Iceberg metric column names. `position` is derived from `sum_position`. */
const METRIC_SQL: Record<string, string> = {
  clicks: 'SUM(clicks)',
  impressions: 'SUM(impressions)',
  ctr: 'CASE WHEN SUM(impressions) = 0 THEN 0 ELSE SUM(clicks) * 1.0 / SUM(impressions) END',
  position: 'CASE WHEN SUM(impressions) = 0 THEN NULL ELSE SUM(sum_position) * 1.0 / SUM(impressions) END',
}

/**
 * GSC dimension → parquet column. `device` has no long column on `dates` — it
 * is served by the device-pivot archetypes, not generic dimension SQL.
 */
const DIM_COLUMN: Record<string, string> = {
  page: 'url',
  query: 'query',
  country: 'country',
  date: 'date',
  searchAppearance: 'search_appearance',
}

/**
 * Which fact-table view answers a given dimension set. A query touching both
 * `page` and `query` needs `page_queries`; otherwise the single-dimension
 * table. `date`-only resolves to `dates` (true site totals incl. anonymized
 * impressions). `device` resolves to `dates` (device breakdown is pivoted into
 * wide columns there; device archetypes unpivot).
 */
function tableForDimensions(dims: readonly string[]): string {
  const set = new Set(dims.filter(d => d !== 'date'))
  if (set.has('page') && set.has('query'))
    return 'page_queries'
  if (set.has('query'))
    return 'queries'
  if (set.has('country'))
    return 'countries'
  if (set.has('device'))
    return 'dates'
  // page-only, searchAppearance-only, or date-only.
  return 'pages'
}

function metricExpr(metric: string): string {
  const expr = METRIC_SQL[metric]
  if (!expr)
    throw new Error(`[archetype-sql] unknown metric: ${metric}`)
  return expr
}

function metricSelectList(metrics: readonly string[]): string {
  return metrics.map(m => `${metricExpr(m)} AS ${m}`).join(', ')
}

/** `dates` device-pivot column suffixes. */
const DEVICE_VALUES = ['DESKTOP', 'MOBILE', 'TABLET'] as const
const DEVICE_SUFFIX: Record<string, string> = { DESKTOP: 'desktop', MOBILE: 'mobile', TABLET: 'tablet' }

/**
 * Per-device metric expression reading the wide pivot columns on `dates`.
 * `position` is `sum_position_{d} / impressions_{d}`.
 */
function deviceMetricExpr(metric: string, suffix: string): string {
  switch (metric) {
    case 'clicks': return `SUM(clicks_${suffix})`
    case 'impressions': return `SUM(impressions_${suffix})`
    case 'ctr': return `CASE WHEN SUM(impressions_${suffix}) = 0 THEN 0 ELSE SUM(clicks_${suffix}) * 1.0 / SUM(impressions_${suffix}) END`
    case 'position': return `CASE WHEN SUM(impressions_${suffix}) = 0 THEN NULL ELSE SUM(sum_position_${suffix}) * 1.0 / SUM(impressions_${suffix}) END`
    default: throw new Error(`[archetype-sql] unknown metric: ${metric}`)
  }
}

/**
 * UNPIVOT the `dates` device columns into a long `(device, ...metrics)` shape
 * via a UNION ALL of one literal-device SELECT per device. `byDate` adds
 * `date` to the projection + grouping.
 */
function deviceUnpivotSql(
  metrics: readonly string[],
  whereSql: string,
  byDate: boolean,
): string {
  const dateCol = byDate ? 'date, ' : ''
  const dateGroup = byDate ? ' GROUP BY date' : ''
  return DEVICE_VALUES.map((dv) => {
    const suffix = DEVICE_SUFFIX[dv]
    const mcols = metrics.map(m => `${deviceMetricExpr(m, suffix)} AS ${m}`).join(', ')
    return `SELECT ${dateCol}'${dv}' AS device, ${mcols} FROM dates WHERE ${whereSql}${dateGroup}`
  }).join(' UNION ALL ')
}

/** `date BETWEEN ? AND ? AND search_type = ?` predicate + params. */
function rangePredicate(q: ArchetypeQuery & { range: { start: string, end: string }, searchType: string }): { sql: string, params: unknown[] } {
  return {
    sql: 'date BETWEEN ? AND ? AND search_type = ?',
    params: [q.range.start, q.range.end, q.searchType],
  }
}

/**
 * Compile one archetype query to DuckDB SQL. Throws for `aux-cloud-only`.
 */
export function compileArchetypeSql(query: ArchetypeQuery): CompiledArchetypeSql {
  switch (query.archetype) {
    // ── 1. Site-level daily timeseries ──────────────────────────────────────
    case 'site-daily-timeseries': {
      // `dates` carries one row per (site, search_type, date) with TRUE site
      // totals — no GROUP BY needed, and it includes anonymized impressions
      // that a dimension-grouped table would drop.
      const table = 'dates'
      const where = rangePredicate(query)
      return {
        table,
        sql: `SELECT date, ${query.metrics.map(m => `${metricExpr(m)} AS ${m}`).join(', ')} FROM ${table} `
          + `WHERE ${where.sql} GROUP BY date ORDER BY date`,
        params: where.params,
      }
    }

    // ── 2. Per-entity daily timeseries ──────────────────────────────────────
    case 'entity-daily-timeseries': {
      const table = tableForDimensions([query.entity.dimension])
      const col = DIM_COLUMN[query.entity.dimension]!
      const where = rangePredicate(query)
      return {
        table,
        sql: `SELECT date, ${metricSelectList(query.metrics)} FROM ${table} `
          + `WHERE ${where.sql} AND ${col} = ? GROUP BY date ORDER BY date`,
        params: [...where.params, query.entity.value],
      }
    }

    // ── 3. Per-entity daily sparkline (top-N entities at once) ──────────────
    case 'entity-daily-sparkline': {
      const table = tableForDimensions([query.dimension])
      const col = DIM_COLUMN[query.dimension]!
      const where = rangePredicate(query)
      if (query.entities.length === 0)
        throw new Error('[archetype-sql] entity-daily-sparkline requires resolved entities')
      const placeholders = query.entities.map(() => '?').join(', ')
      return {
        table,
        sql: `SELECT ${col} AS entity, date, ${metricExpr(query.metric)} AS ${query.metric} `
          + `FROM ${table} WHERE ${where.sql} AND ${col} IN (${placeholders}) `
          + `GROUP BY ${col}, date ORDER BY ${col}, date`,
        params: [...where.params, ...query.entities],
      }
    }

    // ── 4. Top-N breakdown table ────────────────────────────────────────────
    case 'top-n-breakdown': {
      const table = tableForDimensions([query.dimension])
      const where = rangePredicate(query)
      const dir = query.orderBy.dir === 'asc' ? 'ASC' : 'DESC'
      if (query.dimension === 'device') {
        // `dates` stores the device breakdown pivoted; unpivot then rank.
        let sql = `SELECT device, ${query.metrics.join(', ')} FROM (`
          + `${deviceUnpivotSql(query.metrics, where.sql, false)}) `
          + `ORDER BY ${query.orderBy.metric} ${dir} LIMIT ?`
        const params = [...where.params, ...where.params, ...where.params, query.limit]
        if (query.offset && query.offset > 0) {
          sql += ' OFFSET ?'
          params.push(query.offset)
        }
        return { table, sql, params }
      }
      const col = DIM_COLUMN[query.dimension]!
      let sql = `SELECT ${col} AS ${query.dimension}, ${metricSelectList(query.metrics)} `
        + `FROM ${table} WHERE ${where.sql} GROUP BY ${col} `
        + `ORDER BY ${query.orderBy.metric} ${dir} LIMIT ?`
      const params = [...where.params, query.limit]
      if (query.offset && query.offset > 0) {
        sql += ' OFFSET ?'
        params.push(query.offset)
      }
      return { table, sql, params }
    }

    // ── 5. Single-row lookup ────────────────────────────────────────────────
    case 'single-row-lookup': {
      const dims = Object.keys(query.match)
      const table = tableForDimensions(dims)
      const where = rangePredicate(query)
      const matchParts: string[] = []
      const matchParams: unknown[] = []
      for (const [dim, value] of Object.entries(query.match)) {
        const col = DIM_COLUMN[dim]
        if (!col)
          throw new Error(`[archetype-sql] single-row-lookup: unknown dimension ${dim}`)
        matchParts.push(`${col} = ?`)
        matchParams.push(value)
      }
      const matchSql = matchParts.length ? ` AND ${matchParts.join(' AND ')}` : ''
      return {
        table,
        sql: `SELECT ${metricSelectList(query.metrics)} FROM ${table} `
          + `WHERE ${where.sql}${matchSql}`,
        params: [...where.params, ...matchParams],
      }
    }

    // ── 6. Multi-series stacked daily ───────────────────────────────────────
    case 'multi-series-stacked-daily': {
      const table = tableForDimensions([query.seriesDimension])
      const where = rangePredicate(query)
      if (query.seriesDimension === 'device') {
        return {
          table,
          sql: `SELECT date, device, ${query.metric} FROM (`
            + `${deviceUnpivotSql([query.metric], where.sql, true)}) ORDER BY date, device`,
          params: [...where.params, ...where.params, ...where.params],
        }
      }
      const col = DIM_COLUMN[query.seriesDimension]!
      return {
        table,
        sql: `SELECT date, ${col} AS ${query.seriesDimension}, ${metricExpr(query.metric)} AS ${query.metric} `
          + `FROM ${table} WHERE ${where.sql} GROUP BY date, ${col} ORDER BY date, ${col}`,
        params: where.params,
      }
    }

    // ── 7. Preset analyzer (striking-distance et al.) ───────────────────────
    case 'preset-analyzer': {
      // Presets that need window functions are tagged `arbitrary-sql` instead;
      // the ones here are plain GROUP BY + HAVING. Compile the common
      // striking-distance shape; other presets supply their own params.
      const table = 'queries'
      const where = rangePredicate(query)
      const params = (query.params ?? {}) as Record<string, unknown>
      const minPos = Number(params.minPosition ?? 4)
      const maxPos = Number(params.maxPosition ?? 20)
      const minImpr = Number(params.minImpressions ?? 10)
      const limit = Number(params.limit ?? 1000)
      return {
        table,
        sql: `SELECT query, ${metricExpr('clicks')} AS clicks, ${metricExpr('impressions')} AS impressions, `
          + `${metricExpr('position')} AS position `
          + `FROM ${table} WHERE ${where.sql} GROUP BY query `
          + `HAVING position BETWEEN ? AND ? AND impressions > ? `
          + `ORDER BY impressions DESC LIMIT ?`,
        params: [...where.params, minPos, maxPos, minImpr, limit],
      }
    }

    // ── 8. Two-dimension (page × query) detail ──────────────────────────────
    case 'two-dimension-detail': {
      const table = 'page_queries'
      const where = rangePredicate(query)
      const filterParts: string[] = []
      const filterParams: unknown[] = []
      if (query.filter?.page) {
        filterParts.push('url = ?')
        filterParams.push(query.filter.page)
      }
      if (query.filter?.query) {
        filterParts.push('query = ?')
        filterParams.push(query.filter.query)
      }
      const filterSql = filterParts.length ? ` AND ${filterParts.join(' AND ')}` : ''
      let sql = `SELECT url AS page, query, ${metricSelectList(query.metrics)} `
        + `FROM ${table} WHERE ${where.sql}${filterSql} GROUP BY url, query`
      const params = [...where.params, ...filterParams]
      if (query.orderBy) {
        const dir = query.orderBy.dir === 'asc' ? 'ASC' : 'DESC'
        sql += ` ORDER BY ${query.orderBy.metric} ${dir}`
      }
      if (typeof query.limit === 'number') {
        sql += ' LIMIT ?'
        params.push(query.limit)
      }
      return { table, sql, params }
    }

    // ── 9. Arbitrary SQL ────────────────────────────────────────────────────
    case 'arbitrary-sql': {
      // Caller-supplied SQL referencing the attached views by their Iceberg
      // table name. Run verbatim — the browser DuckDB has full window-function
      // support, so the `duckdb` execution-class archetype runs locally.
      return {
        table: 'page_queries',
        sql: query.sql,
        params: [...(query.params ?? [])],
      }
    }

    // ── 10. Aux cloud-only ──────────────────────────────────────────────────
    case 'aux-cloud-only':
      throw new Error('[archetype-sql] aux-cloud-only is not an Iceberg query — route to the cloud endpoint')

    default:
      throw new Error(`[archetype-sql] unhandled archetype: ${(query as ArchetypeQuery).archetype}`)
  }
}

/** The fact-table view an archetype reads — drives per-table browser routing. */
export function tableForArchetype(query: ArchetypeQuery): string | null {
  if (query.archetype === 'aux-cloud-only')
    return null
  return compileArchetypeSql(query).table
}
