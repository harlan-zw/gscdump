# gscdump

[![npm version](https://img.shields.io/npm/v/gscdump?color=yellow)](https://npmjs.com/package/gscdump)
[![npm downloads](https://img.shields.io/npm/dm/gscdump?color=yellow)](https://npm.chart.dev/gscdump)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

Direct Google Search Console and Bing Webmaster clients with typed queries and Indexing Evidence.

## Install

```bash
npm install gscdump
```

`gscdump` requires Node 22 or newer. It talks to Google over `fetch`; it does not require the Google API client packages.

## Query Search Analytics

Create a client with an access token, an OAuth-like client, or refresh-token credentials:

```ts
import { googleSearchConsole } from 'gscdump'

const client = googleSearchConsole({ accessToken: 'ya29.xxx' })
const sites = await client.sites()
```

Use `fetchOptions` for custom headers, request hooks, or retry settings:

```ts
const client = googleSearchConsole('ya29.xxx', {
  fetchOptions: {
    headers: new Headers({ 'x-project': 'analytics' }),
    retry: 0,
    timeout: 10_000,
    onRequest({ options }) {
      options.headers.set('x-request-id', crypto.randomUUID())
    },
  },
})
```

Request hooks run after authentication. The client awaits each hook, including arrays of hooks.
If you omit retry settings, requests use three retries and respect Google's `Retry-After` header.

Use `gscdump/query` to build a request. `client.query()` paginates through Google's 25,000-row pages and yields each non-empty batch.

```ts
import { googleSearchConsole } from 'gscdump'
import { and, between, date, daysAgo, gsc, page, query, today } from 'gscdump/query'

const client = googleSearchConsole('ya29.xxx')
const siteUrl = 'sc-domain:example.com'

const request = gsc
  .select(page, query)
  .where(and(
    between(date, daysAgo(28), today()),
  ))

for await (const rows of client.query(siteUrl, request)) {
  for (const row of rows)
    console.log(row.page, row.query, row.clicks)
}
```

If you already have a Search Analytics request body, call the direct operation:

```ts
const response = await client.searchAnalytics.query(siteUrl, {
  startDate: '2026-06-01',
  endDate: '2026-06-30',
  dimensions: ['page'],
  rowLimit: 1000,
})
```

## Other Google resources

The same client exposes the Google resources owned by this package:

```ts
const sitemapList = await client.sitemaps.list(siteUrl)
const inspection = await client.inspect(siteUrl, 'https://example.com/docs')

await client.indexing.publish(
  'https://example.com/jobs/frontend-engineer',
  'URL_UPDATED',
)
```

The package root also exports batch and projection helpers such as `fetchSitesWithSitemaps`, `batchInspectUrlsFlatSettled`, `inspectUrlFlat`, and `batchRequestIndexing`.

## Read Bing Indexing Evidence

Use `gscdump/bing` with an OAuth access token. The client returns tagged
`Result` values and never infers an indexed verdict from crawl evidence.

```ts
import { bingWebmaster } from 'gscdump/bing'

const client = bingWebmaster({ accessToken: 'access-token' })
const evidence = await client.getIndexingEvidence(
  'https://example.com/',
  'https://example.com/docs',
)

if (evidence.ok)
  console.log(evidence.value)

const [pages, queries, crawl] = await Promise.all([
  client.getPageStats('https://example.com/'),
  client.getQueryStats('https://example.com/'),
  client.getCrawlStats('https://example.com/'),
])
```

Sitemap XML reading and traversal lives in `sitemapd`. Product feed scoping and
exact membership hashing live in `gscdump/sitemap-identity`. Hosted canonical
sitemap membership is available through `@gscdump/sdk/v1`.

## Public subpaths

- `gscdump/query`: query builder, columns, operators, Pacific date helpers, and logical query plans
- `gscdump/query/plan`: logical query planning only
- `gscdump/bing`: Bing Site, URL, traffic, and crawl evidence calls
- `gscdump/dates`: explicit UTC and Pacific Search Console date helpers
- `gscdump/contracts`: Search Analytics request and response contracts
- `gscdump/result`: `Result` helpers
- `gscdump/normalize`: URL normalization
- `gscdump/tenant`: site ID encoding and normalization

Hosted gscdump.com clients live in [`@gscdump/sdk`](../sdk). Storage engines and analyzers live in [`@gscdump/engine`](../engine) and [`@gscdump/analysis`](../analysis).

## License

[MIT](../../LICENSE)
