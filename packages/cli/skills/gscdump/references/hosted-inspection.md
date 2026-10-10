# Hosted inspection

- [Inspect and index](#inspect-and-index)
- [Find URLs Google has not indexed (hosted)](#find-urls-google-has-not-indexed-hosted)
- [Inspect one Sitemap (hosted)](#inspect-one-sitemap-hosted)
- [Read the coverage ladder (hosted)](#read-the-coverage-ladder-hosted)
- [Watch URLs (hosted)](#watch-urls-hosted)
- [Refresh hosted Google URL Inspection results](#refresh-hosted-google-url-inspection-results)

## Inspect and index

```sh
gscdump inspect https://example.com/page https://example.com/other --site example.com --json
gscdump inspect --site example.com --file urls.txt --json
gscdump indexing quota --json
```

Inspection spends Google's separate quota: 2,000 requests per day and 600 per minute for each property.
`inspect` refuses more than 2,000 URLs in one run. It saves each result to the Store.
On a quota error it stops and reports `remaining`. It exits 1 when any URL fails or remains.
`indexing quota` describes Indexing API limits. It does not report remaining URL Inspection requests.
Report the Indexing Evidence fields as Google returned them.

## Find URLs Google has not indexed (hosted)

```sh
gscdump indexing urls --site example.com --status not_indexed --json
gscdump indexing urls --site example.com --status not_indexed --all --format csv
```

- The command reads URL Inspection results that gscdump.com already saved. It spends no inspection quota.
- `--status` takes `indexed`, `not_indexed`, or `pending`. `--search` keeps URLs that contain the text.
- Each row lists the sitemaps that contain the URL.
- Pages hold 100 rows by default and 500 at most. Use `--offset` for the next page, or `--all` for every page.
- With local authentication, the command fails. Pipe `gscdump sitemaps urls <sitemap-url>` into `gscdump inspect --site <site>` instead.

## Inspect one Sitemap (hosted)

```sh
gscdump sitemaps inspect https://example.com/sitemap-old.xml --site example.com --engine google --json
gscdump sitemaps inspect https://example.com/sitemap-old.xml --site example.com --engine bing --json
```

Google reads that exact Sitemap from Search Console during the request.
That read uses Google's API quota, without spending URL Inspections.
Bing reads its stored provider list. Quote `capture.capturedAt` and `capture.source` with the answer.
`listed` carries provider dates, flags, and counts. A null date means the provider supplied no date.
`missing` means that exact Sitemap was absent at Capture time.
`unavailable` means gscdump could not establish the evidence. The command exits with code 1.
The command never submits a Sitemap or inspects URLs inside it.
For Hosted MCP, use `inspect-sitemap` at `https://gscdump.com/mcp`.

## Read the coverage ladder (hosted)

```sh
gscdump indexing summary --site example.com --json
gscdump indexing summary --site example.com --days 90 --json
```

The command reads saved URL Inspection verdicts. It spends no inspection quota.
Each day in `trend` has `coverageStates`:

- `counted` has `counts`, one URL count per coverage state, and `capturedAt`, the time gscdump counted them.
- `not_counted` means gscdump stored the day before it counted coverage states. That day has no ladder. Say so.

Read the 4 ladder states in `counts`, lowest rung first. Name each state with these words:

| Key | Name | Meaning |
| --- | --- | --- |
| `unknown_to_google` | unknown | URL Inspection reported the URL as unknown at its check time |
| `discovered_not_indexed` | discovered | URL Inspection reported discovery without a crawl at its check time |
| `crawled_not_indexed` | crawled | URL Inspection reported a crawl without indexing at its check time |
| `indexed` | indexed | URL Inspection reported the URL as indexed at its check time |

The other keys in `counts` are exclusions, such as `noindex`, `not_found`, and `redirect`.
`unrecognized` counts coverage text gscdump cannot map yet. `not_reported` counts results with no coverage text.
A newer host can add keys to `counts`. Treat a key you do not know as its own state. Treat a missing key as 0.

Rules for every answer:

- `capture.source` is `stored` for counts gscdump saved on its daily run, and `live` for counts made during the request.
- Quote `capturedAt` with every count. Also quote `capture.oldestVerdictAt` and the `capture.freshness` percents: `olderThan7dPercent` and `olderThan30dPercent`.
- If `capture._tag` is `empty`, gscdump holds no verdicts for the Site. Report no ladder.
- The counts are stored URL Inspection verdicts. They are not Google's live index.
  They are also not the Search Console Page indexing report. The two can differ a lot, and the Page indexing report can list many more URLs.
- `olderThan7d` and `olderThan30d` count verdicts inspected more than 7 times 24 hours and 30 times 24 hours before `capturedAt`. They are not calendar days.
- A verdict can be months older than its capture. Unchanged URLs are rechecked less often over time. Say when most verdicts are old.
- Unknown and discovered verdicts do not show Google's current crawl queue. They do not prove noindex or content rejection.
- An accepted indexing request does not confirm crawling or indexing. Compare its receipt date with the saved inspection date.
- If the saved inspection predates a request, it cannot show that request's outcome. A live indexability test also cannot confirm indexing.
- A move between rungs shows in the trend. Compare two `counted` days and name the dates.
- `capture.scope` says which URLs the counts cover. `sitemap_members` means every counted URL is in a live sitemap.
  `inspected_urls` means sitemap membership was not available, so the counts can include URLs outside every sitemap.
- If `unknown_to_google` URLs are already in a sitemap, the sitemap is not the gap. Do not tell the owner to add them to it.
  Read the sitemap's last download with `gscdump sitemaps current --site SITE --json`. Compare that date with each saved inspection date.
  A sitemap download confirms that Google read the feed. It does not confirm discovery, crawling, or indexing of every URL.
  Check one URL's membership with `gscdump sitemaps membership`.
- Name no cause beyond what the evidence shows.
- Cite the command behind each number.

## Watch URLs (hosted)

```sh
gscdump indexing watch add --site example.com https://example.com/guide https://example.com/pricing
gscdump indexing watch list --site example.com --json
gscdump indexing watch remove --site example.com https://example.com/pricing
```

- A Site can hold 50 Watched URLs. `add` and `remove` send 50 URLs per request, so a longer list works. Every URL must be absolute. `add` fails before any request if one is relative.
- If `add` skips a URL with `inspection_disabled`, the Site has URL Inspection off. gscdump never inspects it, so the URL gets no Checkpoint. Tell the owner to turn on URL Inspection in the Site settings.
- gscdump inspects each Watched URL every 7 days, before other scheduled URLs. It never backs off.
- Each scheduled inspection spends the Site's daily URL Inspection budget and the URL Inspections meter. Get consent before `add`.
- Each scheduled inspection stores one Checkpoint. `watch list --json` returns Checkpoints newest first, with `checkedAt`, the `coverageState` key, and Google's text.
- Compare Checkpoints by date to see when a URL moves up the ladder. A new Watched URL has no Checkpoint until its first inspection.
- `remove` deletes the URL's Checkpoints. The saved URL Inspection results stay.


## Refresh hosted Google URL Inspection results

```sh
gscdump indexing inspect https://example.com/page --site example.com --yes --json
```

This asks Google for its current indexed-page verdict. It does not run a live-page test or request indexing.
Pass 1 to 10 unique URLs, or use `--file` or stdin. The platform enforces its shared daily quota.
The command sends one request. It never splits batches or retries automatically.
If the API returns 429, wait for the reported reset before another request.
If `errors` or `skipped` contains URLs, the command exits 1 and preserves its result on stdout.
Read `rateLimit.remaining` before deciding whether to inspect more URLs.
