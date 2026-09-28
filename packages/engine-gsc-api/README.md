# @gscdump/engine-gsc-api

[![npm version](https://img.shields.io/npm/v/@gscdump/engine-gsc-api?color=yellow)](https://npmjs.com/package/@gscdump/engine-gsc-api)
[![npm downloads](https://img.shields.io/npm/dm/@gscdump/engine-gsc-api?color=yellow)](https://npm.chart.dev/@gscdump/engine-gsc-api)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

Use Google Search Console as an `AnalysisQuerySource`.
This adapter runs Analyzers with row plans without a local Store.

## Install

```bash
npm install @gscdump/engine-gsc-api @gscdump/analysis gscdump
```

## Query live rows

```ts
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { googleSearchConsole } from 'gscdump'
import { between, date, gsc, page } from 'gscdump/query'

const client = googleSearchConsole({ accessToken: process.env.GSC_ACCESS_TOKEN! })
const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })
const state = gsc.select(page)
  .where(between(date, '2026-08-01', '2026-08-28'))
  .limit(100)
  .getState()

const rows = await source.queryRows(state)
console.log(rows)
```

See [`@gscdump/analysis`](../analysis/README.md#sources) for Analyzer dispatch.

## Deferred authentication

`createLiveGscSource({ siteUrl, getAccessToken })` calls your token function on the first query.
It reuses the resulting client for that Source's lifetime.
Create a Source per request if your host manages token refresh between requests.

## Exports

| Export | Purpose |
| --- | --- |
| `createGscApiQuerySource` | Wrap a Google client as a Source |
| `createLiveGscSource` | Create a Source with deferred token lookup |
| `canProxyToGsc` | Check whether query inputs support live routing |
| `fetchGscTopN` | Read top rows for a dimension and date range |
| `fetchGscDaily` | Read daily metrics |
| `runGscSyncSlice` | Read a bounded Search Analytics sync slice |
| `runGscSearchAppearanceContextSlice` | Read a Search Appearance context slice |
| `planGscSyncWork` | Find ledger gaps and size Sync windows |
| `tablesCoveredByGscSync` | List the tables a Sync slice must write |
| `ledgerTablesForGscSync` | List the ledger tables needed for one fanout |
| `planGscBackfillDates` | Select interior repair or backward Backfill dates |

## Plan stored Sync work

Pass the dates you want to cover, the planned `(table, searchType)` fanout, and
the dates already committed to your ledger. The plan returns only missing
windows. Record zero-row slices in the ledger too, so they do not repeat.

```ts
import { planGscSyncWork } from '@gscdump/engine-gsc-api'

const plan = planGscSyncWork({
  dates: ['2026-09-01', '2026-09-02'],
  fanout: [{ table: 'pages' }, { table: 'queries' }],
  ledger: [{ table: 'pages', searchType: 'web', date: '2026-09-01' }],
  pagesPerDayEstimate: 100,
})

for (const window of plan.windows) {
  // Run runGscSyncSlice for this table and date range, then commit its ledger rows.
  console.log(window)
}
```

The defaults match the hosted Worker's tested window budget. Set `rowBudget`,
`maxSpanDays`, and `maxWindowsPerRun` for your own runtime. The window count
limit can widen a span beyond `maxSpanDays` during a long catch-up.

## Limits and fallback

The Source supports row queries and regex filters.
It has no SQL execution, comparison joins, or Engine-derived dimensions such as `queryCanonical`.
`canProxyToGsc` rejects malformed inputs, prefilters, and Engine-derived dimensions in selections or filters.
Metric filters remain supported after row collection.

`createCompositeSource` from `@gscdump/analysis/source` accepts `{ engine, live, site }`.
It sends supported queries to Google when stored coverage or dimensions cannot answer them.
The `site` input supplies sync bounds and optional covered date spans.
SQL execution uses the Engine.

Google's [Search Analytics limits](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data) still apply.

## License

[MIT](../../LICENSE)
