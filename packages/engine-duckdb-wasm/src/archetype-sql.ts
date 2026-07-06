/**
 * Archetype → DuckDB SQL compiler.
 *
 * Compiles the 10 typed `ArchetypeQuery` shapes (`@gscdump/contracts/archetypes`) into SQL that
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

import type { ArchetypeQuery } from '@gscdump/contracts/archetypes'

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
  // Fact-table convention: `sum_position = (position − 1) × impressions`, so
  // the mean must be recovered with `+ 1` (parity with the cloudflare
  // sibling's `metricExpr`).
  position: 'CASE WHEN SUM(impressions) = 0 THEN NULL ELSE SUM(sum_position) * 1.0 / SUM(impressions) + 1 END',
}

/**
 * GSC dimension → parquet column. `device` has no long column on `dates` — it
 * is served by the device-pivot archetypes, not generic dimension SQL.
 *
 * `queryCanonical` is derived from a `query_dim` relation joined by raw query,
 * with raw query as the fallback. The fact views do not carry
 * `query_canonical`.
 */
const DIM_COLUMN: Record<string, string> = {
  page: 'url',
  query: 'query',
  country: 'country',
  date: 'date',
  searchAppearance: 'search_appearance',
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function qualifiedColumn(table: string, column: string): string {
  return `${quoteIdent(table)}.${quoteIdent(column)}`
}

function queryCanonicalExpr(table: string): string {
  const queryRef = qualifiedColumn(table, 'query')
  return `COALESCE((SELECT qd.query_canonical FROM query_dim qd WHERE qd.query = ${queryRef} LIMIT 1), ${queryRef})`
}

function dimExpr(dim: string, table: string): string {
  return dim === 'queryCanonical' ? queryCanonicalExpr(table) : (DIM_COLUMN[dim] ?? dim)
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
  if (set.has('page') && (set.has('query') || set.has('queryCanonical')))
    return 'page_queries'
  if (set.has('query') || set.has('queryCanonical'))
    return 'queries'
  if (set.has('country'))
    return 'countries'
  if (set.has('device'))
    return 'dates'
  // page-only, searchAppearance-only, or date-only.
  return 'pages'
}

function tableForTopNBreakdown(query: Extract<ArchetypeQuery, { archetype: 'top-n-breakdown' }>): string {
  const dims = [query.dimension]
  for (const facet of query.facets ?? []) {
    const hasPage = query.dimension === 'page' || facet.column === 'page'
    const hasQuery = query.dimension === 'query' || query.dimension === 'queryCanonical' || facet.column === 'query' || facet.column === 'queryCanonical'
    if (hasPage && hasQuery)
      dims.push(facet.column)
  }
  return tableForDimensions(dims)
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
const DEVICE_SUFFIX: Record<typeof DEVICE_VALUES[number], string> = {
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
  TABLET: 'tablet',
}

/**
 * Per-device metric expression reading the wide pivot columns on `dates`.
 * `position` is `sum_position_{d} / impressions_{d}`.
 */
function deviceMetricExpr(metric: string, suffix: string): string {
  switch (metric) {
    case 'clicks': return `SUM(clicks_${suffix})`
    case 'impressions': return `SUM(impressions_${suffix})`
    case 'ctr': return `CASE WHEN SUM(impressions_${suffix}) = 0 THEN 0 ELSE SUM(clicks_${suffix}) * 1.0 / SUM(impressions_${suffix}) END`
    // Fact-table convention: `sum_position_{d} = (position − 1) × impressions_{d}`,
    // so the mean must be recovered with `+ 1` (parity with the non-device
    // `position` metric above and the cloudflare sibling's `metricExpr`).
    case 'position': return `CASE WHEN SUM(impressions_${suffix}) = 0 THEN NULL ELSE SUM(sum_position_${suffix}) * 1.0 / SUM(impressions_${suffix}) + 1 END`
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

// `date BETWEEN ? AND ?` predicate + params. NB: NO `search_type` predicate.
// The attached DuckDB view is ALREADY scoped to one (site, searchType) — the
// host attaches a per-`<table>_<sid>_<searchType>` view per analyzer instance and
// rewrites the logical table name to it, so every row already belongs to this
// searchType. A `search_type = '<str>'` predicate is therefore redundant, and on
// an INT-encoded catalog it is also WRONG: the column is INT (search_type code),
// so binding the string `'web'` throws `Conversion Error: Could not convert
// string 'web' to INT32` and the whole browser query falls back to the server.
// Dropping it makes the browser path encoding-agnostic. (Mirrors the existing
// "sliced by search type, so no search_type predicate is needed" convention.)
function rangePredicate(q: { range: { start: string, end: string } }): { sql: string, params: unknown[] } {
  return {
    sql: 'date BETWEEN ? AND ?',
    params: [q.range.start, q.range.end],
  }
}

/** Same predicate over the comparison window (also without `search_type`). */
function compareRangePredicate(q: { compareRange?: { start: string, end: string } }): { sql: string, params: unknown[] } | null {
  if (!q.compareRange)
    return null
  return {
    sql: 'date BETWEEN ? AND ?',
    params: [q.compareRange.start, q.compareRange.end],
  }
}

/** The four standard metrics emitted as previous-period columns when comparing. */
const STD_METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const

/** `COALESCE(<src>.<metric>, 0) AS <metric>`, casting count metrics to DOUBLE. */
function coalesceMetric(metric: string, src: string, alias: string): string {
  const ref = `${src}.${metric}`
  return (metric === 'clicks' || metric === 'impressions')
    ? `CAST(COALESCE(${ref}, 0) AS DOUBLE) AS ${alias}`
    : `COALESCE(${ref}, 0) AS ${alias}`
}

/** `prev<Metric>` alias for a comparison column. */
function prevAlias(metric: string): string {
  return `prev${metric.charAt(0).toUpperCase()}${metric.slice(1)}`
}

/**
 * Movers re-ranking over the joined current (`c`) / previous (`p`) CTEs.
 * `improving`/`declining` rank by click delta; `new`/`lost` filter on
 * impressions appearing / disappearing. Returns the `WHERE` body (sans keyword)
 * and the `ORDER BY` body. Shared verbatim by both engine compilers.
 */
function moverClause(movers: string): { where: string, order: string } {
  const curClicks = 'COALESCE(c.clicks, 0)'
  const prevClicks = 'COALESCE(p.clicks, 0)'
  const curImpr = 'COALESCE(c.impressions, 0)'
  const prevImpr = 'COALESCE(p.impressions, 0)'
  switch (movers) {
    case 'improving':
      return { where: `${curClicks} > ${prevClicks}`, order: `(${curClicks} - ${prevClicks}) DESC` }
    case 'declining':
      return { where: `${curClicks} < ${prevClicks}`, order: `(${curClicks} - ${prevClicks}) ASC` }
    case 'new':
      return { where: `${prevImpr} = 0 AND ${curImpr} > 0`, order: `${curClicks} DESC, ${curImpr} DESC` }
    case 'lost':
      return { where: `${curImpr} = 0 AND ${prevImpr} > 0`, order: `${prevImpr} DESC` }
    default:
      throw new Error(`[archetype-sql] unknown movers mode: ${movers}`)
  }
}

/**
 * Cross-cutting facet predicates (Country/Device/Brand). `eq` → `col = ?`;
 * `regex`/`notRegex` → DuckDB `regexp_matches(LOWER(col), ?)` (brand
 * classification on `query`). Returns a leading ` AND …` fragment so it appends
 * directly after the range predicate. The caller is responsible for only
 * passing facets whose column exists on the table it reads — the GSC fact
 * tables are single-dimension aggregates, so e.g. a `country` facet is only
 * meaningful against the `countries`/`page_queries` views, not `pages`.
 */
function facetPredicate(query: ArchetypeQuery, table: string): { sql: string, params: unknown[] } {
  const facets = (query as { facets?: readonly { column: string, op: string, value: string }[] }).facets
  if (!facets?.length)
    return { sql: '', params: [] }
  const parts: string[] = []
  const params: unknown[] = []
  for (const f of facets) {
    const col = dimExpr(f.column, table)
    switch (f.op) {
      case 'eq':
        parts.push(`${col} = ?`)
        params.push(f.value)
        break
      case 'regex':
        parts.push(`regexp_matches(LOWER(${col}), ?)`)
        params.push(f.value)
        break
      case 'notRegex':
        parts.push(`NOT regexp_matches(LOWER(${col}), ?)`)
        params.push(f.value)
        break
      default:
        throw new Error(`[archetype-sql] unknown facet op: ${(f as { op: string }).op}`)
    }
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params }
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
      const col = dimExpr(query.entity.dimension, table)
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
      const col = dimExpr(query.dimension, table)
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
      const table = tableForTopNBreakdown(query)
      const where = rangePredicate(query)
      const cmp = compareRangePredicate(query)
      const dir = query.orderBy.dir === 'asc' ? 'ASC' : 'DESC'
      // compareRange branches join `FROM cur c FULL OUTER JOIN prev p` and
      // re-alias the qualified `c.<metric>` back to the bare output name, which
      // makes a bare `ORDER BY <metric>` ambiguous on strict planners (R2 SQL /
      // DataFusion 40004; DuckDB tolerates it). Order by the qualified coalesced
      // current-range value — same ordering, unambiguous. Mirrors the
      // @gscdump/cloudflare server-tail sibling.
      const compareOrder = `COALESCE(c.${query.orderBy.metric}, 0) ${dir}`
      const metricList = query.metrics.includes(query.orderBy.metric)
        ? query.metrics
        : [...query.metrics, query.orderBy.metric]
      // `queryCanonical` rows surface the count of distinct raw queries collapsed
      // under one canonical (the `{N}v` badge).
      const variantSel = query.dimension === 'queryCanonical' ? ', COUNT(DISTINCT query) AS variantCount' : ''

      if (query.dimension === 'device') {
        // `dates` stores the device breakdown pivoted; unpivot then rank.
        if (cmp) {
          // Join each device's previous-period totals so rows carry `prev*`.
          const curCols = metricList.map(m => coalesceMetric(m, 'c', m)).join(', ')
          const prevCols = STD_METRICS.map(m => coalesceMetric(m, 'p', prevAlias(m))).join(', ')
          let sql = `WITH cur AS (${deviceUnpivotSql(metricList, where.sql, false)}), `
            + `prev AS (${deviceUnpivotSql(STD_METRICS, cmp.sql, false)}) `
            + `SELECT COALESCE(c.device, p.device) AS device, ${curCols}, ${prevCols} `
            + `FROM cur c FULL OUTER JOIN prev p ON c.device = p.device `
            + `ORDER BY ${compareOrder} LIMIT ?`
          const params = [...where.params, ...where.params, ...where.params, ...cmp.params, ...cmp.params, ...cmp.params, query.limit]
          if (query.offset && query.offset > 0) {
            sql += ' OFFSET ?'
            params.push(query.offset)
          }
          return { table, sql, params }
        }
        let sql = `SELECT device, ${metricList.join(', ')} FROM (`
          + `${deviceUnpivotSql(metricList, where.sql, false)}) `
          + `ORDER BY ${query.orderBy.metric} ${dir} LIMIT ?`
        const params = [...where.params, ...where.params, ...where.params, query.limit]
        if (query.offset && query.offset > 0) {
          sql += ' OFFSET ?'
          params.push(query.offset)
        }
        return { table, sql, params }
      }
      const col = dimExpr(query.dimension, table)
      const facet = facetPredicate(query, table)
      // Full group count (independent of LIMIT/OFFSET) for load-more tables.
      // `COUNT(*) OVER()` evaluates over the grouped result before LIMIT, so it
      // reports every distinct dimension value matching the WHERE/facet.
      const totalCol = query.includeTotal ? ', COUNT(*) OVER() AS __total' : ''

      if (cmp) {
        // Current + previous grouped CTEs joined per dimension key so every
        // current row carries its TRUE previous-period metrics (`prev*`),
        // independent of whether it ranked in the previous period's top-N.
        const curCols = metricList.map(m => coalesceMetric(m, 'c', m)).join(', ')
        const prevCols = STD_METRICS.map(m => coalesceMetric(m, 'p', prevAlias(m))).join(', ')
        const variantOut = query.dimension === 'queryCanonical' ? ', c.variantCount AS variantCount' : ''
        // Movers re-rank by period-over-period movement (Growing/Declining/New/
        // Lost); otherwise rank by the requested metric.
        const mover = query.movers ? moverClause(query.movers) : null
        const moverWhere = mover ? `WHERE ${mover.where} ` : ''
        const orderSql = mover ? mover.order : compareOrder
        let sql = `WITH cur AS (SELECT ${col} AS k, ${metricSelectList(metricList)}${variantSel} FROM ${table} WHERE ${where.sql}${facet.sql} GROUP BY ${col}), `
          + `prev AS (SELECT ${col} AS k, ${metricSelectList(STD_METRICS)} FROM ${table} WHERE ${cmp.sql}${facet.sql} GROUP BY ${col}) `
          + `SELECT COALESCE(c.k, p.k) AS ${query.dimension}, ${curCols}, ${prevCols}${variantOut}${totalCol} `
          + `FROM cur c FULL OUTER JOIN prev p ON c.k = p.k `
          + `${moverWhere}ORDER BY ${orderSql} LIMIT ?`
        const params = [...where.params, ...facet.params, ...cmp.params, ...facet.params, query.limit]
        if (query.offset && query.offset > 0) {
          sql += ' OFFSET ?'
          params.push(query.offset)
        }
        return { table, sql, params }
      }

      let sql = `SELECT ${col} AS ${query.dimension}, ${metricSelectList(query.metrics)}${variantSel}${totalCol} `
        + `FROM ${table} WHERE ${where.sql}${facet.sql} GROUP BY ${col} `
        + `ORDER BY ${query.orderBy.metric} ${dir} LIMIT ?`
      const params = [...where.params, ...facet.params, query.limit]
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
        const col = dimExpr(dim, table)
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
      const col = dimExpr(query.seriesDimension, table)
      return {
        table,
        sql: `SELECT date, ${col} AS ${query.seriesDimension}, ${metricExpr(query.metric)} AS ${query.metric} `
          + `FROM ${table} WHERE ${where.sql} GROUP BY date, ${col} ORDER BY date, ${col}`,
        params: where.params,
      }
    }

    // ── 7. (retired) Preset analyzer — analysis presets run through the
    //       analyzer registry (`analyze({ type })`), not this archetype. ADR-0044.

    // ── 8. Two-dimension (page × query) detail ──────────────────────────────
    case 'two-dimension-detail': {
      const table = 'page_queries'
      const where = rangePredicate(query)
      const facet = facetPredicate(query, table)
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
        + `FROM ${table} WHERE ${where.sql}${filterSql}${facet.sql} GROUP BY url, query`
      const params = [...where.params, ...filterParams, ...facet.params]
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
