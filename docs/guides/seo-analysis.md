# SEO analysis

Use a Report for a question that needs several Analyzers.
Use `analyze` when you want one Analyzer's results.

## Prepare data

```bash
gscdump sync --site sc-domain:example.com --days 90 --tables pages,queries,page_queries,countries
```

The CLI reads the Store by default.
If no local data is available, sync first or pass `--live`.
Live Sources support Analyzers with row plans; SQL-only Analyzers need stored data.

## Start with a Report

```bash
gscdump report list
gscdump report opportunities --site sc-domain:example.com --json
gscdump report movers --site sc-domain:example.com --period 28d --vs prev-period --json
```

Reports return a `ReportResult` with bounded Sections and next steps.
Use `--explain` to inspect a Report plan without authentication or data access.

```bash
gscdump report triage --target /blog/post --target-kind page --explain
gscdump report pre-publish --topic widgets --explain
```

See the [Report list](../../README.md#reports) for default windows and required inputs.

## Run one Analyzer

| Analyzer | What to look for |
| --- | --- |
| `striking-distance` | Queries in positions 4 to 20 with low CTR and enough impressions |
| `opportunity` | Queries ranked by position, impressions, and CTR gap |
| `movers` | Queries gaining or losing traffic between two periods |
| `decay` | Pages losing clicks between two periods |
| `cannibalization` | Multiple pages receiving impressions for the same query |
| `zero-click` | Queries with high impressions and low CTR |
| `concentration` | Traffic concentrated in a few pages or queries |

These results identify candidates for review.
They do not establish why traffic changed or guarantee gains from an edit.

```bash
gscdump analyze striking-distance --site sc-domain:example.com --json
gscdump analyze cannibalization --site sc-domain:example.com --json
gscdump analyze zero-click --site sc-domain:example.com --json
gscdump analyze brand --site sc-domain:example.com --brand-terms 'acme,acme corp' --json
```

Analyzer windows default to the last 28 days that end on the newest synced day.
Use `--period`, or `--start` and `--end`, for other ranges.
`movers` and `decay` compare with the previous period by default. To compare other dates, pass both comparison flags:

```bash
gscdump analyze decay --site sc-domain:example.com \
  --start 2026-08-01 --end 2026-08-28 --prev-start 2026-07-04 --prev-end 2026-07-31 --json
```

`--vs` belongs to `report`.
`--limit` caps the rows shown. If a live fetch reaches its row budget, the output shows a partial-data warning; `--fetch-budget` raises the budget up to 100000 rows.
Check `gscdump analyze <tool> --help` for each Analyzer's supported flags.

## Analyze rows in TypeScript

Install the analysis package:

```bash
npm install @gscdump/analysis
```

```ts
import { analyzeStrikingDistance } from '@gscdump/analysis'

const rows = [{
  query: 'example query',
  page: 'https://example.com/docs',
  clicks: 5,
  impressions: 1000,
  ctr: 0.005,
  position: 8,
}]

const results = analyzeStrikingDistance(rows, {
  minPosition: 4,
  maxPosition: 20,
  minImpressions: 100,
})

console.log(results[0]?.keyword, results[0]?.potentialClicks)
```

The existing result field is named `keyword`; it contains the query text.
`potentialClicks` estimates clicks at a fixed 15% CTR.
It is a heuristic, not a traffic forecast.

## Analyze live data in TypeScript

```bash
npm install @gscdump/analysis @gscdump/engine @gscdump/engine-gsc-api gscdump
```

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

For SQL and browser examples, see [`@gscdump/analysis`](../../packages/analysis/README.md).

## Next steps

- [Keep historical data](./historical-database.md)
- [Connect an AI assistant](./ai-integration.md)
