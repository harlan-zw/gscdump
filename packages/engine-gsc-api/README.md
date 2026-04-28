# @gscdump/engine-gsc-api

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-gsc-api?color=yellow)](https://npmjs.com/package/@gscdump/engine-gsc-api)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-gsc-api?color=yellow)](https://npm.chart.dev/@gscdump/engine-gsc-api)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> GSC live-API engine adapter — wraps the Search Analytics REST API as an `AnalysisQuerySource` for typed analyzer dispatch.

Wraps the Google Search Console live REST API as a `RowQuerySource` so row-based analyzers (`striking-distance`, `opportunity`, `movers`, `decay`, `brand`, `clustering`, `concentration`, `seasonality`) dispatch through the same `runAnalyzerFromSource` pipeline as engine-backed sources.

Use this when you have a GSC OAuth token but no synced parquet data — free-tier flows, demo pages, queries whose date range falls outside the synced window. Pair with `createCompositeSource` to fall back to GSC for out-of-range queries.

## Install

```bash
npm install @gscdump/engine-gsc-api @gscdump/engine gscdump
```

## Usage

```ts
import { analyzeMoversFromSource } from '@gscdump/analysis'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { googleSearchConsole } from 'gscdump'

const client = googleSearchConsole(auth)
const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })

const movers = await analyzeMoversFromSource(source, {
  current: { startDate: '2026-04-01', endDate: '2026-04-28' },
  previous: { startDate: '2026-03-01', endDate: '2026-03-31' },
})
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

- `createGscApiQuerySource({ client, siteUrl })` — `RowQuerySource` over a `GoogleSearchConsoleClient`.
- `createLiveGscSource({ siteUrl, getAccessToken })` — token-refresh wrapper on top of `createGscApiQuerySource`.
- `canProxyToGsc(state)` — guard for `createCompositeSource`: returns `true` if a `BuilderState` can be answered by GSC's native API (no metric filters, no engine-derived dimensions).
- `fetchGscTopN({ client, siteUrl, dimension, range, limit })` — typed top-N rollup helper.
- `fetchGscDaily({ client, siteUrl, range })` — typed daily timeseries helper.
- `collectGscRows(asyncIterable)` — drain `client.query()` into an array.
- `applyBuilderStatePostProcessing(rows, state)` — post-process row collections for predicates GSC can't push down (metric filters, special operators).
- `GSC_API_CAPABILITIES` — `PlannerCapabilities` for the GSC API surface.

## Capabilities

GSC supports regex pushdown via `INCLUDING_REGEX` / `EXCLUDING_REGEX` filters but has no SQL surface, no comparison joins, no cross-dataset queries, and no engine-derived dimensions (`queryCanonical`, `page_keywords`). Pair with `createCompositeSource({ engine, gsc })` from `@gscdump/analysis/source` to route SQL-shaped queries to the engine and date-out-of-range queries to GSC.

## Related

- [`@gscdump/engine`](../engine) — Source contracts (`RowQuerySource`, `AnalysisQuerySource`).
- [`@gscdump/analysis`](../analysis) — Analyzer instances + `createCompositeSource`.
- [`gscdump`](../gscdump) — REST client + query builder.

## License

[MIT](../../LICENSE)
