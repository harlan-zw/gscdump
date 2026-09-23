# URL inspection and indexing

Read Google and Bing Indexing Evidence, save Google inspections, and manage sitemap submissions.
Google inspection and sitemap commands use the selected cloud or local authentication.

## Inspect URLs

```bash
gscdump inspect https://example.com/blog/post --site sc-domain:example.com --json

gscdump inspect https://example.com/a https://example.com/b --site sc-domain:example.com --json

gscdump inspect --site sc-domain:example.com --file urls.txt --json
```

Pass one or more URLs, a file with one URL per line, or both.
With neither, the command reads URLs from piped stdin.
Results include Google's verdict, coverage state, last crawl, canonical URLs, and available rich-result details.
Fields may be absent when Google has no evidence for them.

Each result is saved to the Store's inspection history as it arrives.
`dump` exports these records, and `sync` treats a URL inspected here as fresh.
Read the latest saved record for a URL:

```bash
gscdump entities show https://example.com/blog/post --site sc-domain:example.com
```

Google allows 2,000 URL inspections per day and 600 per minute for each property.
The command refuses more than 2,000 URLs in one run and starts at most 500 calls per minute.
If Google reports a quota error, the command stops, keeps the saved results, and prints how many URLs remain.
A URL outside the Site fails without an API call.
The command exits 1 when any URL fails or remains.

To save Google's notification metadata too:

```bash
gscdump entities indexing snapshot --mode local --site sc-domain:example.com --file urls.txt
```

## Send eligible indexing notifications

Google limits its Indexing API to pages with `JobPosting` or `BroadcastEvent` inside `VideoObject` markup.
Complete [Google's prerequisites](https://developers.google.com/search/apis/indexing-api/v3/quickstart), including service-account access and approval.
For other page types, use sitemaps and Search Console's URL Inspection interface.
Indexing API requests require local Google credentials, including when cloud mode is saved.

```bash
gscdump indexing submit https://example.com/jobs/frontend-engineer --mode local

gscdump indexing status https://example.com/jobs/frontend-engineer --mode local

gscdump indexing batch --mode local --file job-urls.txt --concurrency 1 --json
```

`indexing status` reads notification metadata.
Use `inspect` to read Google's Indexing Evidence for the URL.

After removing an eligible page from your server, send its removal notification:

```bash
gscdump indexing remove https://example.com/jobs/expired-role --mode local
```

Google's initial testing quota allows 200 publish requests per project per day, shared by updates and removals.
It resets at midnight Pacific time.
Check your project's actual quota and approval in [Google's quota guide](https://developers.google.com/search/apis/indexing-api/v3/quota-pricing).

Batch concurrency and delays control request pacing.
The CLI does not track the project's remaining daily quota.

## Manage sitemaps

```bash
gscdump sitemaps list --site sc-domain:example.com

gscdump sitemaps submit https://example.com/sitemap.xml --site sc-domain:example.com

gscdump sitemaps delete https://example.com/old-sitemap.xml --site sc-domain:example.com
```

A sitemap submission tells Google where to find URLs.
Inspect individual URLs to see the evidence Google currently returns for them.

The CLI also supports hosted sitemap reads through `sitemaps current`, `history`, `membership`, `lastmod`, and `export`.
These require a hosted Site ID and cloud authentication from the current profile or environment.
Use each command's `--help` for its inputs.

## Inspect with Bing

```bash
# Use the saved cloud connection for this Site.
gscdump bing inspect https://example.com/page --site s_SITE_ID --mode cloud --json

# Use local Bing credentials and the exact URL from bing sites.
gscdump bing inspect https://example.com/page --site https://example.com/ --mode local --json
```

Cloud mode reads saved Bing Indexing Evidence. Local mode reads Bing directly.
An unknown result does not prove that a URL is absent from Bing's index.

## TypeScript

```ts
import { googleSearchConsole } from 'gscdump'

const client = googleSearchConsole({ accessToken: process.env.GSC_ACCESS_TOKEN! })
const siteUrl = 'sc-domain:example.com'
const url = 'https://example.com/blog/post'

const result = await client.inspect(siteUrl, url)
console.log(result.inspectionResult?.indexStatusResult?.coverageState)

const sitemaps = await client.sitemaps.list(siteUrl)
console.log(sitemaps)
```

For ordered, per-URL results, use `batchInspectUrlsFlatSettled` from `gscdump`.
For Bing, see [Bing Indexing Evidence](../../packages/gscdump/README.md#read-bing-indexing-evidence).

## Next steps

- [Keep historical data](./historical-database.md)
- [Connect an AI assistant](./ai-integration.md)
