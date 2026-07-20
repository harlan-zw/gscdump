# SEO Analysis Playbook

gscdump includes built-in analysis functions for common SEO tasks. Each analysis identifies issues and suggests actions.

## Available Analyses

| Analysis | What It Finds |
|----------|---------------|
| `striking-distance` | Keywords ranking 4-20 with high impressions |
| `opportunity` | Keywords with best optimization potential |
| `movers` | Significant ranking/traffic changes |
| `decay` | Pages losing traffic over time |
| `cannibalization` | Multiple pages competing for same keyword |
| `zero-click` | High-impression queries with low CTR |

## Striking Distance Keywords

Find keywords almost on page 1 - small improvements yield big gains.

```bash
npx @gscdump/cli analyze striking-distance -s sc-domain:example.com
```

**What it finds:** Keywords in positions 4-20 with high impressions but few clicks.

**Action:** Optimize title tags, add internal links, improve content depth.

### Programmatic

```ts
import { analyzeStrikingDistance, fetchKeywordsWithComparison } from 'gscdump'

const { current } = await fetchKeywordsWithComparison(auth, site, range)
const striking = analyzeStrikingDistance(current, {
  minPosition: 4,
  maxPosition: 20,
  minImpressions: 100,
})

// Returns: { keyword, page, position, impressions, clicks, potential }[]
```

## Content Decay Detection

Find pages that were performing well but are now declining.

```bash
npx @gscdump/cli analyze decay -s sc-domain:example.com --period 90d
```

**What it finds:** Pages with significant traffic drops vs previous period.

**Action:** Update outdated content, refresh statistics, add new sections.

### Programmatic

```ts
import { analyzeDecay, fetchPagesWithComparison } from 'gscdump'

const { current, previous } = await fetchPagesWithComparison(auth, site, range)
const decaying = analyzeDecay(current, previous, {
  minClicksChange: -20, // Lost at least 20 clicks
  minChangePercent: -0.2, // 20%+ decline
})

// Returns: { page, currentClicks, previousClicks, changePercent }[]
```

## Keyword Cannibalization

Find keywords where multiple pages compete against each other.

```bash
npx @gscdump/cli analyze cannibalization -s sc-domain:example.com
```

**What it finds:** Keywords ranking for 2+ pages, splitting your authority.

**Action:** Consolidate content, add canonical tags, or differentiate intent.

### Programmatic

```ts
import { analyzeCannibalization } from 'gscdump'

// Requires keyword×page data
const cannibalized = analyzeCannibalization(keywordPageData, {
  minPages: 2,
  minImpressions: 50,
})

// Returns: { keyword, pages: [{ url, position, clicks }], impactScore }[]
```

## Movers & Shakers

Track significant ranking changes - both winners and losers.

```bash
npx @gscdump/cli analyze movers -s sc-domain:example.com --period 28d
```

**What it finds:** Keywords/pages with biggest position or traffic changes.

**Action:** Investigate drops (algorithm update? competitor?), double down on gains.

### Programmatic

```ts
import { analyzeMovers, fetchKeywordsWithComparison } from 'gscdump'

const { current, previous } = await fetchKeywordsWithComparison(auth, site, range)
const movers = analyzeMovers(current, previous, {
  minPositionChange: 5,
  minClicksChange: 10,
})

// Returns: { keyword, currentPosition, previousPosition, positionChange, ... }[]
```

## Zero-Click Queries

Find queries getting impressions but no clicks - SERP features may be stealing traffic.

```bash
npx @gscdump/cli analyze zero-click -s sc-domain:example.com
```

**What it finds:** High-impression queries with CTR below threshold.

**Action:** Target featured snippets, improve meta descriptions, check SERP features.

### Programmatic

```ts
import { analyzeZeroClick, fetchKeywordsWithComparison } from 'gscdump'

const { current } = await fetchKeywordsWithComparison(auth, site, range)
const zeroClick = analyzeZeroClick(current, {
  minImpressions: 100,
  maxCtr: 0.01, // Less than 1% CTR
})
```

## Opportunity Scoring

Composite score ranking keywords by optimization potential.

```bash
npx @gscdump/cli analyze opportunity -s sc-domain:example.com
```

Factors in: position (room to improve), impressions (search volume), CTR gap (vs expected).

## Traffic Concentration

Check if you're over-reliant on few pages/keywords.

```ts
import { analyzeKeywordConcentration, analyzePageConcentration } from 'gscdump'

const pageConcentration = analyzePageConcentration(pages)
const keywordConcentration = analyzeKeywordConcentration(keywords)

// HHI thresholds:
// < 1500: Low risk (well distributed)
// 1500-2500: Medium risk
// > 2500: High risk (over-reliance)
```

## Combining Analyses

Run multiple analyses for a complete audit:

```ts
import {
  analyzeCannibalization,
  analyzeDecay,
  analyzeMovers,
  analyzeStrikingDistance,
  fetchKeywordsWithComparison,
  fetchPagesWithComparison,
} from 'gscdump'
import { daysAgo, today } from 'gscdump/query'

const range = { period: { start: daysAgo(90), end: today() } }

const [keywords, pages] = await Promise.all([
  fetchKeywordsWithComparison(auth, site, range),
  fetchPagesWithComparison(auth, site, range),
])

const audit = {
  striking: analyzeStrikingDistance(keywords.current),
  decay: analyzeDecay(pages.current, pages.previous),
  movers: analyzeMovers(keywords.current, keywords.previous),
}
```

## Next Steps

- [AI Integration](/docs/guides/ai-integration) - Ask Claude to run analyses
- [Historical Database](/docs/guides/historical-database) - Run analysis on historical data
