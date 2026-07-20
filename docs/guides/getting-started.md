# Getting Started

Export your first Google Search Console data in under 5 minutes.

## Prerequisites

- Node.js 22+
- Access to at least one Google Search Console property

## Quick Setup

```bash
# Run the init wizard
npx @gscdump/cli init
```

You'll be prompted to choose an auth mode:

| Mode | Best For |
|------|----------|
| **Cloud** | Quick setup, no API keys needed |
| **Local** | Full control, your own OAuth credentials |

### Cloud Mode (Recommended)

Select "cloud" and follow the browser auth flow. Done.

### Local Mode

1. Create a [Google Cloud project](https://console.cloud.google.com/)
2. Enable "Search Console API" and "Web Search Indexing API"
3. Create OAuth2 credentials (Desktop app type)
4. Run `npx @gscdump/cli init` and paste your credentials

## List Your Sites

```bash
npx @gscdump/cli sites
```

Output:
```
sc-domain:example.com
https://example.com/
https://staging.example.com/
```

## Export Data

### Quick Dump (stdout)

```bash
# Last 7 days of page data
npx @gscdump/cli dump --site sc-domain:example.com --period 7d

# Last 28 days of keywords
npx @gscdump/cli dump --site sc-domain:example.com --period 28d --dimensions keywords
```

### Export to File

```bash
# JSON
npx @gscdump/cli dump -s sc-domain:example.com -p 90d -o ./export.json

# CSV
npx @gscdump/cli dump -s sc-domain:example.com -p 90d -f csv -o ./export.csv
```

### Multiple Dimensions

```bash
# Pages + keywords + devices
npx @gscdump/cli dump -s sc-domain:example.com -d pages,keywords,devices
```

## Period Formats

| Format | Meaning |
|--------|---------|
| `7d` | Last 7 days |
| `28d` | Last 28 days |
| `90d` | Last 90 days |
| `2024-01-01:2024-01-31` | Specific date range |
| `lastMonth` | Previous calendar month |
| `lastWeek` | Previous calendar week |

## Set Defaults

Avoid repeating flags:

```bash
npx @gscdump/cli config set defaultSite sc-domain:example.com
npx @gscdump/cli config set defaultPeriod 90d
```

Now just run:
```bash
npx @gscdump/cli dump
```

## Next Steps

- [Build a Historical Database](/docs/guides/historical-database) - Persist data to SQLite
- [SEO Analysis](/docs/guides/seo-analysis) - Find optimization opportunities
- [AI Integration](/docs/guides/ai-integration) - Let Claude query your data
