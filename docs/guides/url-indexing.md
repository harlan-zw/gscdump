# URL Indexing Management

Check index status, request indexing, and track results across your site.

## Check Index Status

### Single URL

```bash
npx @gscdump/cli inspect -s sc-domain:example.com -u https://example.com/blog/post
```

Returns:
- Coverage state (Indexed, Crawled, Excluded, etc.)
- Last crawl time
- Indexing issues
- Mobile usability status

### Batch Inspect

```bash
# Inspect all pages in DB
npx @gscdump/cli index inspect -s sc-domain:example.com

# Inspect from sitemap
npx @gscdump/cli index inspect -s sc-domain:example.com --from-sitemap
```

## Request Indexing

### Single URL

```bash
npx @gscdump/cli index request -s sc-domain:example.com -u https://example.com/new-page
```

### Batch Request

```bash
# Request indexing for URLs in DB marked as needing it
npx @gscdump/cli index request -s sc-domain:example.com --batch

# From a file
npx @gscdump/cli index request -s sc-domain:example.com --file urls.txt
```

### Rate Limits

Google's Indexing API has quotas:
- **200 requests/day** per project
- Batch operations respect this limit automatically

## Track Status in Database

Sync URL indexing status to your local DB:

```bash
# Initial inspection + sync
npx @gscdump/cli sync -s sc-domain:example.com --db ./gsc.db --indexing
```

This creates `site_path_indexing` table tracking:
- Coverage state
- Last inspected
- Last indexing request
- Issues

### Query Indexing Stats

```bash
npx @gscdump/cli index status -s sc-domain:example.com
```

Output:
```
Indexed:     1,234 (82%)
Crawled:       156 (10%)
Excluded:       89 (6%)
Error:          21 (2%)

Last sync: 2024-01-15 06:00
```

## Programmatic Usage

### Inspect URLs

```ts
import { batchInspectUrls, inspectUrl } from 'gscdump/api'

// Single URL
const result = await inspectUrl(auth, 'sc-domain:example.com', 'https://example.com/page')

console.log(result.inspectionResult.indexStatusResult.coverageState)
// 'Submitted and indexed' | 'Crawled - currently not indexed' | etc.

// Batch inspect (handles rate limiting)
const results = await batchInspectUrls(auth, 'sc-domain:example.com', urls)
```

### Request Indexing

```ts
import { batchRequestIndexing, requestIndexing } from 'gscdump/api'

// Single URL
await requestIndexing(auth, 'https://example.com/new-page')

// Batch with rate limiting
const results = await batchRequestIndexing(auth, urls, {
  onProgress: (completed, total) => console.log(`${completed}/${total}`),
  delayMs: 1000, // Delay between requests
})
```

### Database Operations

```ts
import { createGscDb, getIndexingStats, getUrlsNeedingIndexing, inspectAndSyncUrl } from '@gscdump/db'

const db = createGscDb('./gsc.db')

// Inspect and save to DB
await inspectAndSyncUrl(db, auth, siteId, property, '/blog/post')

// Get summary stats
const stats = await getIndexingStats(db, siteId)
// { indexed: 1234, crawled: 156, excluded: 89, error: 21 }

// Find URLs needing attention
const needsIndexing = await getUrlsNeedingIndexing(db, siteId, {
  states: ['Discovered - currently not indexed', 'Crawled - currently not indexed'],
  limit: 100,
})
```

## Sitemap Management

### List Sitemaps

```bash
npx @gscdump/cli sitemaps -s sc-domain:example.com
```

### Submit Sitemap

```bash
npx @gscdump/cli sitemaps submit -s sc-domain:example.com --url https://example.com/sitemap.xml
```

### Delete Sitemap

```bash
npx @gscdump/cli sitemaps delete -s sc-domain:example.com --url https://example.com/old-sitemap.xml
```

### Programmatic

```ts
import { deleteSitemap, fetchSitemaps, submitSitemap } from 'gscdump/api'

const sitemaps = await fetchSitemaps(auth, 'sc-domain:example.com')

await submitSitemap(auth, 'sc-domain:example.com', 'https://example.com/sitemap.xml')
```

## Workflows

### New Content Workflow

1. Publish content
2. Submit sitemap (if not auto-discovered)
3. Request indexing for new URLs
4. Monitor coverage state

```bash
# After publishing
npx @gscdump/cli index request -s sc-domain:example.com -u https://example.com/new-post

# Check status next day
npx @gscdump/cli inspect -s sc-domain:example.com -u https://example.com/new-post
```

### Audit Workflow

1. Sync all pages to DB
2. Batch inspect coverage
3. Identify issues
4. Request indexing for missed pages

```bash
# Full audit
npx @gscdump/cli sync -s sc-domain:example.com --db ./gsc.db
npx @gscdump/cli index inspect -s sc-domain:example.com --batch
npx @gscdump/cli index status -s sc-domain:example.com

# Fix issues
npx @gscdump/cli index request -s sc-domain:example.com --batch
```

## Coverage States

| State | Meaning | Action |
|-------|---------|--------|
| `Submitted and indexed` | In Google's index | None needed |
| `Crawled - currently not indexed` | Crawled but not indexed | Improve content quality |
| `Discovered - currently not indexed` | Known but not crawled | Request indexing |
| `Excluded by 'noindex' tag` | Intentionally excluded | Check if intentional |
| `Blocked by robots.txt` | Can't crawl | Update robots.txt |
| `URL is unknown to Google` | Never seen | Submit sitemap + request |

## Next Steps

- [Historical Database](/docs/guides/historical-database) - Track indexing over time
- [AI Integration](/docs/guides/ai-integration) - Ask Claude about indexing status
