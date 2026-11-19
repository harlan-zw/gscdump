---
title: gscdump CLI
description: Read Search Console data, keep local history, and investigate search traffic with gscdump.
---

# gscdump CLI

Run Google Search Console queries from your terminal with the gscdump CLI. Read clicks, impressions, and average position for a Site. The CLI also reads Bing, saves a local Store, and runs Reports and Analyzers.

## Run a daily Search Console query

[Install the CLI and set up access](/gscdump-cli/guides/start/first-result). Replace `example.com` with your Site. In Local mode, `--live` reads directly from Search Console. In Hosted mode, omit `--live` to read the record on gscdump.com.

```bash
gscdump query --live --site example.com --dimensions date --limit 1 --format json
```

This excerpt comes from a test fixture.

```json
{
  "data": [{ "date": "2026-10-19", "clicks": 5, "impressions": 50, "ctr": 0.1, "position": 3 }],
  "meta": { "source": "live" }
}
```

The `data` array contains up to one daily row. In `meta.source`, `live` means Search Console returned the row. The same field reads `hosted` in Hosted mode.

## Find your next task

| Start with | When |
| --- | --- |
| [Choose access](/gscdump-cli/guides/start/choose-access) | You need to choose Local mode (your own Google credentials) or Hosted mode (your gscdump.com record). |
| [Run your first query](/gscdump-cli/guides/start/first-result) | You need a working Site and live result. |
| [Use data](/gscdump-cli/guides/use-data) | You need history, filters, or an export. |
| [Investigate traffic](/gscdump-cli/guides/investigate-traffic) | You have a change or opportunity to check. |
| [Check visibility](/gscdump-cli/guides/check-visibility) | You need page overlap or Indexing Evidence. |
| [Connect an agent](/gscdump-cli/guides/start/connect-an-agent) | You want an agent to run the CLI with the packaged skill. |

## Guides

- [Start](/gscdump-cli/guides/start): access, first result, and agent setup.
- [Use data](/gscdump-cli/guides/use-data): Store, queries, and exports.
- [Investigate traffic](/gscdump-cli/guides/investigate-traffic): seven SEO runbooks.
- [Check visibility](/gscdump-cli/guides/check-visibility): pages, sitemaps, Google, and Bing.

## Reference

[Commands](/gscdump-cli/api/commands) · [Query](/gscdump-cli/api/query) · [Export](/gscdump-cli/api/export) · [Sync](/gscdump-cli/api/sync) · [Bing](/gscdump-cli/api/bing) · [Analyzers](/gscdump-cli/api/analyzers) · [Reports](/gscdump-cli/api/reports)
