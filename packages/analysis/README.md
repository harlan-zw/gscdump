# @gscdump/analysis

[![npm version](https://img.shields.io/npm/v/@gscdump/analysis?color=yellow)](https://npmjs.com/package/@gscdump/analysis)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/analysis?color=yellow)](https://npm.chart.dev/@gscdump/analysis)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

SEO Analyzers and Reports for Google Search Console data.
Use pure functions for rows you already have, or run an Analyzer against a Source.

## Install

```bash
npm install @gscdump/analysis
```

Node.js 22 or newer is required for Node consumers.

## Choose an export

| Subpath | Purpose |
| --- | --- |
| `@gscdump/analysis` | Pure Analyzers, browser dispatch, and shared Analyzer contracts |
| `@gscdump/analysis/registry` | All 29 registered Analyzers, including SQL implementations |
| `@gscdump/analysis/report` | Report registry, `runReport`, and formatting |
| `@gscdump/analysis/source` | Composite and in-memory Source factories |
| `@gscdump/analysis/errors` | Typed analysis errors and rendering helpers |

`@gscdump/engine` owns the Analyzer, Source, and period contracts.
The analysis root re-exports the common contracts.
The default registry imports every Analyzer; avoid it when you need a smaller browser bundle.

## Analyze rows

```ts
import { analyzeDecay, analyzeMovers } from '@gscdump/analysis'

const current = [{
  query: 'example query',
  page: 'https://example.com/docs',
  clicks: 40,
  impressions: 1000,
  ctr: 0.04,
  position: 8,
}]
const previous = [{
  query: 'example query',
  page: 'https://example.com/docs',
  clicks: 100,
  impressions: 1000,
  ctr: 0.1,
  position: 4,
}]

const movers = analyzeMovers({ current, previous })
const decay = analyzeDecay({ current, previous })
console.log(movers.declining, decay)
```

Comparison functions take one `{ current, previous }` input object.
Options are a separate second argument.
See the [SEO guide](../../docs/guides/seo-analysis.md) for a complete striking-distance example.

## Sources

Use `runAnalyzerFromSource` to choose an Analyzer's row or SQL plan:

```ts
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { googleSearchConsole } from 'gscdump'

const client = googleSearchConsole({ accessToken: process.env.GSC_ACCESS_TOKEN! })
const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })
const result = await runAnalyzerFromSource(source, {
  type: 'striking-distance',
  startDate: '2026-08-01',
  endDate: '2026-08-28',
  minImpressions: 100,
}, defaultAnalyzerRegistry)

console.log(result.results)
```

Install `@gscdump/engine`, `@gscdump/engine-gsc-api`, and `gscdump` for this example.

Twelve Analyzers have row plans:

- `brand`, `cannibalization`, `clustering`, `concentration`
- `data-detail`, `data-query`, `decay`, `movers`
- `opportunity`, `seasonality`, `striking-distance`, `zero-click`

All 29 Analyzers have SQL plans.
SQL-only Analyzers need a Source that supports their required capabilities.

| Factory | Import path | Input |
| --- | --- | --- |
| `createGscApiQuerySource` | `@gscdump/engine-gsc-api` | `{ client, siteUrl }` |
| `createLiveGscSource` | `@gscdump/engine-gsc-api` | `{ siteUrl, getAccessToken }` |
| `createEngineQuerySource` | `@gscdump/engine/source` | `{ engine, ctx }` |
| `createSqliteQuerySource` | `@gscdump/engine-sqlite` | `{ executor, siteId, regex? }` |
| `createInMemoryQuerySource` | `@gscdump/analysis/source` | `{ queryRows }` |
| `createCompositeSource` | `@gscdump/analysis/source` | `{ engine, live, site }` |

For a composite Source, `site` contains `oldestDateSynced`, `newestDateSynced`, and optional `coveredSpans`.
It routes supported queries to Google when stored coverage is missing or stored dimensions cannot answer the query.
SQL execution always uses the Engine.

## Reports

Reports combine Analyzers into bounded Sections.
After creating `source` above, run a Report supported by that Source:

```ts
import { defaultReportRegistry, runReport } from '@gscdump/analysis/report'
import { resolveWindow } from '@gscdump/engine/period'

const report = defaultReportRegistry.getReport('movers')!
const window = resolveWindow({ preset: 'last-28d', comparison: 'prev-period' })
const result = await runReport(report, {
  source,
  analyzers: defaultAnalyzerRegistry,
  ctx: {
    site: 'sc-domain:example.com',
    window,
    params: {},
    registryVersion: defaultReportRegistry.version,
  },
})

console.log(result.sections, result.meta.degraded)
```

See the [Report list](../../README.md#reports) for inputs and defaults.
If an optional step fails, `meta.degraded` is `true`.
A required step failure rejects the Report.

Use `defineReport` from `@gscdump/engine/report` to define your own Report.

## DuckDB and browser use

For Node, create an Engine Source with `createEngineQuerySource({ engine, ctx })` from `@gscdump/engine/source`.
The context supplies `userId` and `siteId`.
Node attachment helpers live at `@gscdump/engine/node`.

For browsers, use [`@gscdump/engine-duckdb-wasm`](../engine-duckdb-wasm/README.md) to attach Parquet tables.
`analyzeInBrowser` accepts a runner with `query(sql, params, signal?)`, options, analysis parameters, and an Analyzer registry.
Browser analysis uses attached tables as described in [ADR-0001](../../docs/adr/0001-browser-engine-uses-attached-tables.md).

For SQLite and D1, use [`@gscdump/engine-sqlite`](../engine-sqlite/README.md).
Analyzer support depends on the Source's SQL dialect and capabilities.

## Date windows

```ts
import { resolveWindow } from '@gscdump/analysis'

const window = resolveWindow({ preset: 'last-30d', comparison: 'yoy' })
console.log(window.start, window.end, window.comparison)
```

Presets: `last-7d`, `last-28d`, `last-30d`, `last-90d`, `last-180d`, `last-365d`, `mtd`, `ytd`, and `custom`.
Comparisons: `none`, `prev-period`, and `yoy`.

## Public API

Use the package exports listed above.
Files under `src/` are private and may change without a public migration path.

## License

[MIT](../../LICENSE)
