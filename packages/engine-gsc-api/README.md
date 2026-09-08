# @gscdump/engine-gsc-api

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-gsc-api?color=yellow)](https://npmjs.com/package/@gscdump/engine-gsc-api)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-gsc-api?color=yellow)](https://npm.chart.dev/@gscdump/engine-gsc-api)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> GSC live-API engine adapter — wraps the Search Analytics REST API as an `AnalysisQuerySource` for typed analyzer dispatch.

Wraps Google's live REST API as an `AnalysisQuerySource`.
Run row-based Analyzers through `runAnalyzerFromSource`, using the same interface as other Sources.

Use this when you have a GSC OAuth token but no synced parquet data — free-tier flows, demo pages, queries whose date range falls outside the synced window. Pair with `createCompositeSource` to fall back to GSC for out-of-range queries.

## Install

```bash
npm install @gscdump/engine-gsc-api @gscdump/analysis gscdump
```

## Usage

```ts
import { runAnalyzerFromSource } from '@gscdump/analysis'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { googleSearchConsole } from 'gscdump'

const client = googleSearchConsole('ya29.xxx')
const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })
const movers = await runAnalyzerFromSource(source, {
  type: 'movers',
  startDate: '2026-04-01',
  endDate: '2026-04-28',
  prevStartDate: '2026-03-04',
  prevEndDate: '2026-03-31',
}, defaultAnalyzerRegistry)
console.log(movers.results)
```

For host apps that mint short-lived access tokens per request:

```ts
import { createLiveGscSource } from '@gscdump/engine-gsc-api'

const source = createLiveGscSource({
  siteUrl,
  getAccessToken: () => refreshAccessTokenForUser(userId),
})
```

## Exports

- `createGscApiQuerySource({ client, siteUrl })`: `AnalysisQuerySource` over a `GoogleSearchConsoleClient`.
- `createLiveGscSource({ siteUrl, getAccessToken })` — token-refresh wrapper on top of `createGscApiQuerySource`.
- `canProxyToGsc(state)` — guard for `createCompositeSource`: returns `true` if a `BuilderState` can be answered by GSC's native API (no metric filters, no engine-derived dimensions).
- `fetchGscTopN({ client, siteUrl, dimension, range, limit })` — typed top-N rollup helper.
- `fetchGscDaily({ client, siteUrl, range })` — typed daily timeseries helper.

## Capabilities

GSC supports regex filters. SQL, comparison joins, cross-dataset queries, and Engine-derived dimensions require another Source.
Use `createCompositeSource({ engine, live, site })` from `@gscdump/analysis/source` to combine an Engine Source with a live Source.
The `site` dates define the Engine's available range.

## Related

- [`@gscdump/engine`](../engine): Source contracts (`AnalysisQuerySource`).
- [`@gscdump/analysis`](../analysis) — Analyzer instances and portable source factories.
- [`gscdump`](../gscdump) — REST client + query builder.

## License

[MIT](../../LICENSE)
