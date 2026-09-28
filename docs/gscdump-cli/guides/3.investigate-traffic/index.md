---
title: Investigate search traffic
description: Pick a repeatable SEO investigation and check each Report against source rows.
navigation:
  title: Investigate traffic
---

# Investigate search traffic

Start with a question. Keep the Site, search type, and complete date windows consistent. Check Report Sections against [source rows](/gscdump-cli/guides/use-data/query-and-export).

| Question | Guide | Data |
| --- | --- | --- |
| What changed this week? | [Review search traffic each week](/gscdump-cli/guides/investigate-traffic/weekly-triage) | Store or live |
| Why did one page lose clicks? | [Investigate a page traffic drop](/gscdump-cli/guides/investigate-traffic/traffic-drop) | Needs Store for triage |
| Which queries have weak CTR? | [Find search queries with low CTR](/gscdump-cli/guides/investigate-traffic/low-ctr) | Store for some CTR Analyzers |
| Did brand traffic change? | [Separate brand and non-brand traffic](/gscdump-cli/guides/investigate-traffic/brand-traffic) | Store or live; supply terms |
| Why are impressions not turning into clicks? | [Find queries with impressions but few clicks](/gscdump-cli/guides/investigate-traffic/impressions-no-clicks) | Store or live, where supported |
| Is growth seasonal? | [Check whether search growth is seasonal](/gscdump-cli/guides/investigate-traffic/growth-trends) | Needs Store history |
| Is mobile different? | [Compare traffic by device and search type](/gscdump-cli/guides/investigate-traffic/device-gaps) | Store for device-gap Analyzer |

A live result can omit query detail or hit a row budget. A partly covered Store window stops with a sync command. Read the [Reports](/gscdump-cli/api/reports) and [Analyzers](/gscdump-cli/api/analyzers) references for exact support. For URL questions, [check visibility](/gscdump-cli/guides/check-visibility).
