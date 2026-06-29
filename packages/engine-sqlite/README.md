# @gscdump/engine-sqlite

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-sqlite?color=yellow)](https://npmjs.com/package/@gscdump/engine-sqlite)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-sqlite?color=yellow)](https://npm.chart.dev/@gscdump/engine-sqlite)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> SQLite / D1 engine adapter for `@gscdump/analysis` — typed analytics over sqlite-proxy executors (Cloudflare D1, libsql).

Wraps any sqlite-proxy executor (`(sql, params) => rows`) as a `SqlQuerySource` bound to a tenant `siteId`. Driver glue only; the typed builder + raw-SQL plumbing lives in `@gscdump/engine/resolver`.

Bundle: **5.3 kB / 1.4 kB gzipped**.

## Install

```bash
npm install @gscdump/engine-sqlite @gscdump/engine drizzle-orm
```

## Usage

```ts
import {
  aggClicks,
  aggCtr,
  aggImpressions,
  aggPosition,
  compileSqlite,
  createSqliteInsightRunner,
  gsc_keywords,
  sql,
} from '@gscdump/engine-sqlite'

const queryExpr = sql`
  SELECT ${gsc_keywords.query} as keyword,
         SUM(${gsc_keywords.clicks}) as clicks,
         ${aggCtr(gsc_keywords)} as ctr
  FROM ${gsc_keywords}
  WHERE ${gsc_keywords.site_id} = ${siteId}
  GROUP BY ${gsc_keywords.query}
`

const { sql: compiledSql, params } = compileSqlite(queryExpr)
const rows = await executor(compiledSql, params) // queryUserD1, libsql, ...
```

### Engine source for analyzer dispatch

```ts
import { createEngine } from '@gscdump/engine-sqlite'

const source = createEngine({
  executor, // (sql, params, mode) => { rows }
  siteId,
  regex: true, // hosts that expose REGEXP (D1, libsql, sqlite3+regexp)
})
```

Always import `sql` from `@gscdump/engine-sqlite` — not `drizzle-orm` directly — so consumers bind to the package's drizzle-orm instance and avoid cross-install `SQL<unknown>` mismatches.

## Exports

- `createEngine({ executor, siteId, regex? })` — builds a `SqlQuerySource`.
- `createSqliteInsightRunner({ executor })` — sqlite-proxy drizzle adapter.
- `compileSqlite(sql)` — compile to `{ sql, params }` for any HTTP executor.
- `aggClicks` / `aggImpressions` / `aggCtr` / `aggPosition` — aggregate helpers.
- `scopeFor(table, { siteId, window })` / `mergeScope()` — tenant scope predicates.
- `gsc_pages` / `gsc_keywords` / `gsc_page_keywords` / `gsc_countries` / `gsc_devices` / `schema` — drizzle schema mirroring `gscdump/analytics` `SCHEMAS`.
- `sqliteResolverAdapter` / `createSqliteResolverAdapter` / `probeSqliteRegex` — dialect adapter for the resolver kit.
- `resolveWindow` (re-exported from `@gscdump/engine/period`).

## D1 Analytics Table Status

The `gsc_*` analytics tables remain a supported compatibility surface. The
2026-06-29 Iceberg migration audit found active package exports, resolver tests,
and docs for `gsc_pages`, `gsc_keywords`, `gsc_page_keywords`, `gsc_countries`,
and `gsc_devices`. Do not remove these tables as part of the Iceberg/canonical
migration. A future retirement should be staged behind a consumer usage audit,
dual-read/shadow-read checks, and a release note that names the replacement
Iceberg/R2 SQL path.

## Related

- [`@gscdump/engine`](../engine) — Storage contracts + dialect-neutral resolver.
- [`@gscdump/analysis`](../analysis) — Analyzer registry + dispatcher.
- [`@gscdump/engine-duckdb-node`](../engine-duckdb-node) — Node DuckDB counterpart.
- [`@gscdump/engine-duckdb-wasm`](../engine-duckdb-wasm) — Browser DuckDB-WASM counterpart.

## License

[MIT](../../LICENSE)
