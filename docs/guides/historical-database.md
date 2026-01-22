# Building a Historical Database

Google deletes your Search Console data after 16 months. gscdump lets you keep it forever in a local SQLite database.

## Why Persist to SQLite?

- **No expiry** - Keep data indefinitely
- **Faster queries** - Local DB beats API latency
- **Offline access** - No internet required after sync
- **AI-ready** - MCP server can query DB directly

## First Sync

```bash
# Sync last 90 days to SQLite
npx @gscdump/cli sync --site sc-domain:example.com --db ./gsc.db
```

This syncs:
- Daily site metrics
- Page-level analytics
- Keyword data
- Country/device breakdowns

## What Gets Stored

| Table | Data |
|-------|------|
| `sites` | Your GSC properties |
| `site_date_analytics` | Daily site totals |
| `site_path_date_analytics` | Daily page metrics |
| `site_keyword_date_analytics` | Daily keyword metrics |
| `site_date_country_analytics` | Country breakdown |
| `site_date_device_analytics` | Device breakdown |

## Sync Options

### Full Sync (All Dimensions)

```bash
npx @gscdump/cli sync -s sc-domain:example.com --db ./gsc.db --all
```

### Keyword × Page Data (Most Granular)

```bash
npx @gscdump/cli sync -s sc-domain:example.com --db ./gsc.db --keyword-paths
```

This creates `site_keyword_path_date_analytics` - useful for cannibalization analysis.

### Specific Period

```bash
# Backfill historical data
npx @gscdump/cli sync -s sc-domain:example.com --db ./gsc.db --period 16months
```

## Automate with Cron

### Daily Sync Script

```bash
#!/bin/bash
# sync-gsc.sh
npx @gscdump/cli sync \
  --site sc-domain:example.com \
  --db /path/to/gsc.db \
  --period 7d
```

### Cron Entry

```bash
# Run daily at 6am
0 6 * * * /path/to/sync-gsc.sh >> /var/log/gsc-sync.log 2>&1
```

### GitHub Actions

```yaml
name: Sync GSC Data
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Sync GSC
        env:
          GSCDUMP_ACCESS_TOKEN: ${{ secrets.GSC_ACCESS_TOKEN }}
        run: |
          npx @gscdump/cli sync \
            --site sc-domain:example.com \
            --db ./data/gsc.db \
            --period 7d

      - name: Commit DB
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add data/gsc.db
          git commit -m "chore: sync gsc data" || exit 0
          git push
```

## Database Maintenance

### Prune Old Data

```bash
# Keep only last 2 years
npx @gscdump/cli db prune --days 730
```

### Vacuum (Reclaim Space)

```bash
npx @gscdump/cli db vacuum
```

## Programmatic Access

```ts
import { createGscDb } from '@gscdump/db'

const db = createGscDb('./gsc.db')

// Query pages with comparison
const pages = await queryPagesWithComparison(db, siteId, currentRange, previousRange)

// Get top keywords
const keywords = await getTopKeywords(db, siteId, startDate, endDate, 100)

// Weekly rollup
const weekly = await queryWeeklyRollup(db, siteId, startDate, endDate)
```

## Storage Estimates

| Data Type | ~Size per Site/Month |
|-----------|---------------------|
| Site metrics | ~1 KB |
| Pages (1k pages) | ~50 KB |
| Keywords (10k) | ~500 KB |
| Keyword×Page | ~5 MB |

A typical site with 1k pages and 10k keywords uses ~6 MB/month, or ~72 MB/year.

## Next Steps

- [AI Integration](/docs/guides/ai-integration) - Query your DB with Claude
- [SEO Analysis](/docs/guides/seo-analysis) - Run analysis on historical data
