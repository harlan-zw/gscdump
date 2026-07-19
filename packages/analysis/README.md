# @gscdump/analysis

[![npm version](https://img.shields.io/npm/v/@gscdump/analysis?color=yellow)](https://npmjs.com/package/@gscdump/analysis)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/analysis?color=yellow)](https://npm.chart.dev/@gscdump/analysis)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> SEO analyzers for Google Search Console data. Row-based, DuckDB-native, D1-ready.

## Install

```bash
npm install @gscdump/analysis
```

## When to use which subpath

| Subpath | Use when |
|---|---|
| `@gscdump/analysis` | Top-level barrel: row analyzers, source-backed analyzers, `SQL_ANALYZERS`, `analyzeInBrowser`, `defaultAnalyzerRegistry`, contract types re-exported from engine. |
| `@gscdump/analysis/analyzer` | `ROW_ANALYZERS` array + `paginate*` / `adapt-rows` helpers used by analyzer authors. |
| `@gscdump/analysis/registry` | Pre-built `defaultAnalyzerRegistry` (rows + sql). Convenience for callers who don't care about bundle size. |
| `@gscdump/analysis/source` | Portable query sources (`createInMemoryQuerySource`, `createCompositeSource`) + source-backed analyzers. |
| `@gscdump/analysis/semantic` | Browser-only semantic analyzers such as content-gap; optional `@huggingface/transformers` peer. |
| `@gscdump/analysis/query` | `buildDataQueryPlan` / `buildDataDetailPlan` for the generic query analyzers. |

The contract layer (`Analyzer`, `Plan`, `Capability`, `AnalysisParams`, `AnalysisResult`, `AnalysisQuerySource`, `runAnalyzerFromSource`, `createAnalyzerRegistry`, `defineAnalyzer`, period helpers, `createEngineQuerySource`) lives in `@gscdump/engine` under the `/analyzer`, `/analysis-types`, `/period`, `/source`, and `/resolver` subpaths. Most are re-exported from `@gscdump/analysis` for convenience.

## Row-based analyzers

Pure functions. Take typed arrays in, return typed results out.

```ts
import {
  analyzeBrandSegmentation,
  analyzeClustering,
  analyzeConcentration,
  analyzeDecay,
  analyzeMovers,
  analyzeOpportunity,
  analyzeSeasonality,
  padTimeseries,
} from '@gscdump/analysis'

const movers = analyzeMovers(currentRows, previousRows)
const decay = analyzeDecay(currentRows, previousRows)
```

Meta-analyses live in the report layer. Run a composed, ranked priority list via `runReport`:

```ts
import {
  defaultAnalyzerRegistry,
  defaultReportRegistry,
  runReport,
} from '@gscdump/analysis'
import { resolveWindow } from '@gscdump/engine/period'

const report = defaultReportRegistry.getReport('priority')!
const window = resolveWindow({ preset: 'last-28d', comparison: 'prev-period' })
const result = await runReport(report, {
  source,
  analyzers: defaultAnalyzerRegistry,
  ctx: { site: siteUrl, window, params: {}, registryVersion: defaultReportRegistry.version },
})
// result.sections[0].findings — ranked priority actions, page+query keyed.
```

Source adapters compose a GSC client + analyzer in one call:

```ts
import { analyzeMoversFromSource } from '@gscdump/analysis'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'

const source = createGscApiQuerySource({ client, siteUrl })
const movers = await analyzeMoversFromSource(source, { current, previous })
```

## DuckDB (Node)

SQL-native path. `SQL_ANALYZERS` dispatch through `runAnalyzerFromSource` against an engine-backed source.

```ts
import { ROW_ANALYZERS, SQL_ANALYZERS } from '@gscdump/analysis'
import { createAnalyzerRegistry, runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createEngineQuerySource } from '@gscdump/engine/source'

const source = createEngineQuerySource({ engine, ctx })
const registry = createAnalyzerRegistry({ rows: ROW_ANALYZERS, sql: SQL_ANALYZERS })
const result = await runAnalyzerFromSource(source, { type: 'striking-distance', minImpressions: 100 }, registry)
```

`attachParquetIndex` and `attachSnapshotIndex` from `@gscdump/engine/node`
wire parquet files (per-day, per-month, or pre-baked `.duckdb` snapshots) into
a Node DuckDB session.

## Browser (DuckDB-WASM)

```ts
import { analyzeInBrowser } from '@gscdump/analysis'
// Compose your own narrow registry instead of pulling the kitchen-sink default
// (which statically imports every SQL analyzer). For demo only:
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'

const result = await analyzeInBrowser(
  runner,
  { schema: 'gsc' },
  { type: 'striking-distance' },
  defaultAnalyzerRegistry,
)
```

`analyzeInBrowser` wraps any runner with `query(sql, params, signal?)` in an `AnalysisQuerySource` with the `attachedTables` capability and dispatches via `runAnalyzerFromSource`.

`@gscdump/engine-duckdb-wasm` exports `bootDuckDBWasm`,
`attachParquetUrlTables`, `createBrowserAnalysisRuntime`, and `resolveWindow`
(re-exported from `@gscdump/engine/period`). Browser analysis uses attached
tables rather than a canonical-schema `createEngine`; see ADR-0001.

## SQLite (D1 / Cloudflare Workers)

Mirror of the DuckDB path, dialect-targeted at sqlite-core. `@gscdump/engine-sqlite` exports `createEngine` (a `SqlQuerySource` over `executor + siteId`), `compileSqlite`, drizzle helpers (`gsc_keywords`, etc.), and `resolveWindow` (re-export from `@gscdump/engine/period`).

## Query composers (dialect-neutral)

```ts
import { sqliteResolverAdapter } from '@gscdump/engine-sqlite'
import { pgResolverAdapter, resolveToSQL } from '@gscdump/engine/resolver'

const resolved = resolveToSQL(builderState, { adapter: sqliteResolverAdapter, siteId })
```

Pass `sqliteResolverAdapter` from `@gscdump/engine-sqlite` (D1, `site_id`-scoped) or `pgResolverAdapter` from `@gscdump/engine/resolver` (parquet via DuckDB, single tenant). Composers stay identical; only the column bindings + dialect compilation differ.

## Sources (portable)

`/source` is the cross-implementation seam:

```ts
import { analyzeMoversFromSource } from '@gscdump/analysis'
import { createEngineQuerySource, queryRows } from '@gscdump/engine/source'

const source = createEngineQuerySource({ engine, ctx: { userId, siteId } })

const rows = await queryRows(source, builderState)
const movers = await analyzeMoversFromSource(source, periods)
```

Available source factories:

- `createGscApiQuerySource({ client, siteUrl })` — `@gscdump/engine-gsc-api`
- `createLiveGscSource({ accessToken, siteUrl })` — `@gscdump/engine-gsc-api`
- `createCompositeSource({ engine, gsc })` — `@gscdump/analysis/source`; engine first, GSC fallback
- `createInMemoryQuerySource({ queryRows })` — `@gscdump/analysis/source`
- `createEngineQuerySource({ engine, ctx })` — `@gscdump/engine/source`
- `createEngine({ ... })` — `@gscdump/engine-sqlite`

Portable analyzers currently cover the row-based tools:
`striking-distance`, `opportunity`, `brand`, `clustering`, `concentration`,
`seasonality`, `movers`, and `decay`.

## Semantic (browser-only)

```ts
import { analyzeContentGap } from '@gscdump/analysis/semantic'

const result = await analyzeContentGap(runner, {
  maxQueries: 1500,
  minDivergence: 0.12,
})
```

Loads a MiniLM/BGE embedding model via `@huggingface/transformers`, caches vectors in IndexedDB, and compares top queries to candidate URLs derived from `page_keywords`.

## Window resolution

```ts
import { resolveWindow } from '@gscdump/analysis'

const w = resolveWindow({ preset: 'last-30d', comparison: 'yoy' })
// { start: '...', end: '...', days: 30, comparison: { start, end } }
```

Presets: `last-7d`, `last-28d`, `last-30d`, `last-90d`, `last-180d`, `last-365d`, `mtd`, `ytd`, `custom`. Comparison modes: `none`, `prev-period`, `yoy`.

## Stability

| Surface | Stability |
|---|---|
| Row analyzers (`analyzeMovers`, `analyzeDecay`, ...) | Public |
| Source factories + `analyzeFromSource` | Public |
| `Analyzer<P, R>` contract + `createAnalyzerRegistry` (re-exported from `@gscdump/engine/analyzer`) | Public |
| `/source`, `/semantic`, `/query` subpaths | Public |
| Per-analyzer modules under `analysis/src/analyzers/<name>` | Private |

## Related

- [`gscdump`](../gscdump) — REST client + query builder (edge-safe).
- [`@gscdump/engine`](../engine) — Parquet/DuckDB storage engine + analyzer/source/period contracts.
- [`@gscdump/engine/node`](../engine) — Node DuckDB handle + parquet/snapshot attach helpers.
- [`@gscdump/engine-duckdb-wasm`](../engine-duckdb-wasm) — DuckDB-WASM browser runtime + drizzle adapter.
- [`@gscdump/engine-sqlite`](../engine-sqlite) — SQLite / D1 dialect adapter.
- [`@gscdump/engine-gsc-api`](../engine-gsc-api) — GSC live-API engine adapter.
- [`@gscdump/cli`](../cli) — CLI wrapping `gscdump` + `@gscdump/engine` + `@gscdump/analysis`.

## License

[MIT](../../LICENSE)
