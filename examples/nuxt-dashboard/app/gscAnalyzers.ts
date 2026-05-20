// Single source of truth for analyzer definitions in this dashboard.
// Consumed by:
//   - /sites/[id]/analyze — tab list (analyzer/semantic/action kinds) +
//     unified <GscAnalyzerPanel> dispatch driven by `capabilities.panel`.
//   - /sites/[id]/insights — defs with `capabilities.insightCard`
//   - useActionPriority — defs with `capabilities.actionPriority`
//
// Add a new analyzer by appending one `defineGscAnalyzer({ ... })` entry. To
// give it a custom body on /analyze, supply `capabilities.panel` with a body
// component (lazy-imported via `defineAsyncComponent` to preserve route-level
// codesplitting) plus optional `summarize`/`caption`.

import { defineGscAnalyzer } from '@gscdump/nuxt/types'
import { defineAsyncComponent } from 'vue'

function nfmt(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n))
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback
}

// Lazy panel imports — chart code only loads on the route that renders it.
const CannibalizationAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/CannibalizationAnalyzerPanel.vue'))
const CtrAnomalyAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/CtrAnomalyAnalyzerPanel.vue'))
const VolatilityAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/VolatilityAnalyzerPanel.vue'))
const LongTailAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/LongTailAnalyzerPanel.vue'))
const IntentAtlasAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/IntentAtlasAnalyzerPanel.vue'))
const QueryMigrationAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/QueryMigrationAnalyzerPanel.vue'))
const BayesianCtrAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/BayesianCtrAnalyzerPanel.vue'))
const StlAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/StlAnalyzerPanel.vue'))
const ChangePointAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/ChangePointAnalyzerPanel.vue'))
const PageRankAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/PageRankAnalyzerPanel.vue'))
const SurvivalAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/SurvivalAnalyzerPanel.vue'))
const GenericTableAnalyzerPanel = defineAsyncComponent(() => import('./components/panels/GenericTableAnalyzerPanel.vue'))
const ActionsPipelinePanel = defineAsyncComponent(() => import('./components/panels/ActionsPipelinePanel.vue'))
const ContentGapPipelinePanel = defineAsyncComponent(() => import('./components/panels/ContentGapPipelinePanel.vue'))

// Shared spec for analyzers with no bespoke viz — auto-formatted table.
const genericTablePanel = { component: GenericTableAnalyzerPanel } as const

export const ANALYZERS = [
  defineGscAnalyzer({
    id: 'striking-distance',
    label: 'Striking distance',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      actionPriority: 'striking-distance',
      panel: genericTablePanel,
      insightCard: {
        icon: 'i-lucide-target',
        accent: 'primary',
        description: 'Queries ranking positions 5–20 — one push away from the first page.',
        summarize: res => ({
          headline: nfmt(res.results.length),
          tagline: 'queries ranked 5–20 with upside',
        }),
      },
    },
  }),
  defineGscAnalyzer({
    id: 'opportunity',
    label: 'Opportunity',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      actionPriority: 'opportunity',
      panel: genericTablePanel,
      insightCard: {
        icon: 'i-lucide-zap',
        accent: 'warning',
        description: 'High-impression / low-CTR pages where a title rewrite pays back fast.',
        summarize: res => ({
          headline: nfmt(res.results.length),
          tagline: 'underperforming pages flagged',
        }),
      },
    },
  }),
  defineGscAnalyzer({ id: 'clustering', label: 'Clustering', kind: 'analyzer', isQueryGrained: true, capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'concentration', label: 'Concentration', kind: 'analyzer', isQueryGrained: true, capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'seasonality', label: 'Seasonality', kind: 'analyzer', capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({
    id: 'movers',
    label: 'Movers',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      panel: genericTablePanel,
      insightCard: {
        icon: 'i-lucide-trending-up',
        accent: 'success',
        description: 'Biggest WoW gainers + losers ranked by impression-weighted delta.',
        summarize: res => ({
          headline: nfmt(res.results.length),
          tagline: 'queries with significant movement',
        }),
      },
    },
  }),
  defineGscAnalyzer({ id: 'brand', label: 'Brand', kind: 'analyzer', isQueryGrained: true, capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({
    id: 'cannibalization',
    label: 'Cannibalization',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      actionPriority: 'cannibalization',
      insightCard: {
        icon: 'i-lucide-git-fork',
        accent: 'error',
        description: 'Queries where multiple URLs of yours compete for the same SERP.',
        summarize: (res) => {
          const stolen = typeof res.meta.totalStolenClicks === 'number' ? res.meta.totalStolenClicks : 0
          return { headline: nfmt(stolen), tagline: 'clicks lost to competing URLs' }
        },
      },
      panel: {
        component: CannibalizationAnalyzerPanel,
        summarize: ({ results, meta }) => {
          const graph = meta.graph as { nodes: unknown[], edges: unknown[] } | undefined
          return [
            { label: 'events', value: results.length },
            { label: 'stolen clicks', value: nfmt(asNumber(meta.totalStolenClicks)) },
            { label: 'avg fragmentation', value: `${(asNumber(meta.avgFragmentation) * 100).toFixed(1)}%` },
            { label: 'nodes · edges', value: `${graph?.nodes.length ?? 0} · ${graph?.edges.length ?? 0}` },
          ]
        },
        caption: 'Multi-URL competition per query, computed via SQL self-join in-browser. The GSC API can only tell you queries-per-page; never page-vs-page-per-query.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'ctr-anomaly',
    label: 'CTR anomaly',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      actionPriority: 'ctr-anomaly',
      insightCard: {
        icon: 'i-lucide-alert-octagon',
        accent: 'warning',
        description: 'Pages whose CTR collapsed while position held — likely SERP feature theft.',
        summarize: (res) => {
          const lost = typeof res.meta.totalClicksLost === 'number' ? res.meta.totalClicksLost : 0
          return { headline: nfmt(lost), tagline: 'clicks lost to CTR dips' }
        },
      },
      panel: {
        component: CtrAnomalyAnalyzerPanel,
        summarize: ({ results, meta }) => [
          { label: 'flagged entities', value: results.length },
          { label: 'clicks lost', value: nfmt(asNumber(meta.totalClicksLost)) },
          { label: 'breach days (Σ)', value: asNumber(meta.totalBreachDays) },
          { label: 'z threshold', value: `±${asNumber(meta.zThreshold, 2)}σ` },
        ],
        caption: 'CTR envelope = 28-day rolling mean ±2σ via window functions. Red dots = days where CTR collapsed while position held (likely SERP feature theft).',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'position-volatility',
    label: 'Volatility',
    kind: 'analyzer',
    capabilities: {
      panel: {
        component: VolatilityAnalyzerPanel,
        summarize: ({ results, meta }) => {
          const dates = (meta.dates as string[] | undefined) ?? []
          return [
            { label: 'volatile pages', value: results.length },
            { label: 'days', value: dates.length },
            { label: 'peak volatility', value: asNumber(meta.maxVolatility).toFixed(2) },
          ]
        },
        caption: 'Per-page per-day position σ + DoD shift. Bright cells = pages whose ranking was genuinely noisy that day — not just pages that rank well.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'long-tail',
    label: 'Long-tail',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      insightCard: {
        icon: 'i-lucide-bar-chart-3',
        accent: 'neutral',
        description: 'Pages with healthy tail distribution vs. head-heavy risk concentration.',
        summarize: (res) => {
          const fp = (res.meta.fingerprints as Record<string, number> | undefined) ?? {}
          const flat = fp['flat-tail'] ?? 0
          return { headline: nfmt(flat), tagline: 'pages with a flat, durable tail' }
        },
      },
      panel: {
        component: LongTailAnalyzerPanel,
        summarize: ({ results, meta }) => {
          const fp = (meta.fingerprints as Record<string, number> | undefined) ?? {}
          return [
            { label: 'pages fit', value: results.length },
            { label: 'flat-tail', value: fp['flat-tail'] ?? 0, valueColor: '#2d9a6a' },
            { label: 'balanced', value: fp.balanced ?? 0, valueColor: '#4c3ca0' },
            { label: 'head-heavy', value: fp['head-heavy'] ?? 0, valueColor: '#c52d45' },
            { label: 'avg slope', value: asNumber(meta.avgSlope).toFixed(2) },
          ]
        },
        caption: 'Power-law fit: slope of log(rank) vs log(impressions) via REGR_SLOPE/REGR_INTERCEPT/REGR_R2. Flat = topic authority, steep = single-keyword dependency risk.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'intent-atlas',
    label: 'Intent atlas',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      panel: {
        component: IntentAtlasAnalyzerPanel,
        summarize: ({ results, meta }) => [
          { label: 'clusters', value: results.length },
          { label: 'keywords clustered', value: nfmt(asNumber(meta.totalKeywords)) },
          { label: 'impressions', value: nfmt(asNumber(meta.totalImpressions)) },
        ],
        caption: 'Token-cooccurrence clusters via regexp_split_to_array + unnest. Each tile\'s name is its top-2 most-impression tokens — queries with no shared prefix still group if they share their dominant tokens.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'query-migration',
    label: 'Migration',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      panel: {
        component: QueryMigrationAnalyzerPanel,
        summarize: ({ results, meta }) => {
          const nodes = (meta.nodes as unknown[] | undefined) ?? []
          return [
            { label: 'migration edges', value: results.length },
            { label: 'absorbed impressions', value: nfmt(asNumber(meta.totalAbsorbed)) },
            { label: 'URLs in flow', value: nodes.length },
          ]
        },
        caption: 'Lost ↔ gained queries fuzzy-matched via DuckDB\'s levenshtein(). Edges show which URL absorbed the impressions Google reassigned across the two periods.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'bayesian-ctr',
    label: 'Bayesian CTR',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      panel: {
        component: BayesianCtrAnalyzerPanel,
        summarize: ({ results }) => {
          const rows = results as Array<{ classification: string, expectedClicksDelta: number }>
          const under = rows.filter(r => r.classification === 'underperforming').length
          const over = rows.filter(r => r.classification === 'overperforming').length
          const gap = rows.reduce((s, r) => s + r.expectedClicksDelta, 0)
          return [
            { label: 'entities', value: results.length },
            { label: 'underperforming', value: under, valueColor: '#c52d45' },
            { label: 'overperforming', value: over, valueColor: '#2d9a6a' },
            { label: 'expected-click gap', value: nfmt(gap) },
          ]
        },
        caption: 'Empirical Beta-Binomial shrinkage. Prior fit per position bucket via method-of-moments on impression-weighted CTR; posterior = Beta(α+clicks, β+impr-clicks). 95% CI = normal approx around posterior mean.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'stl-decompose',
    label: 'STL',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      panel: {
        component: StlAnalyzerPanel,
        summarize: ({ results }) => {
          const entities = results as Array<{ seasonalStrength: number }>
          const avg = entities.length
            ? entities.reduce((s, e) => s + e.seasonalStrength, 0) / entities.length
            : 0
          return [
            { label: 'entities', value: results.length },
            { label: 'avg seasonal strength', value: avg.toFixed(2) },
          ]
        },
        caption: 'STL decomposition: trend + seasonality + residual via centered moving averages and per-period detrending; anomalies are residual outliers > 2σ.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'change-point',
    label: 'Change points',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      actionPriority: 'change-point',
      panel: {
        component: ChangePointAnalyzerPanel,
        summarize: ({ results }) => {
          const entities = results as Array<{ direction: string, llr: number }>
          const improved = entities.filter(e => e.direction === 'improved').length
          const worsened = entities.filter(e => e.direction === 'worsened').length
          const maxLlr = entities[0]?.llr ?? 0
          return [
            { label: 'change points', value: results.length },
            { label: 'improved', value: improved, valueColor: '#2d9a6a' },
            { label: 'worsened', value: worsened, valueColor: '#c52d45' },
            { label: 'max LLR', value: maxLlr.toFixed(1) },
          ]
        },
        caption: 'Binary-segmentation change-point detection: at each candidate split date, compare Gaussian log-likelihood of one-segment vs two-segment fits. LLR = Σ n·log(σ²) differential.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'bipartite-pagerank',
    label: 'PageRank',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      panel: {
        component: PageRankAnalyzerPanel,
        summarize: ({ results, meta }) => [
          { label: 'nodes', value: results.length },
          { label: 'iterations', value: asNumber(meta.iterations, 25) },
          { label: 'damping', value: asNumber(meta.damping, 0.85).toFixed(2) },
          { label: 'queries · URLs', value: `${asNumber(meta.queryCount)} · ${asNumber(meta.urlCount)}` },
        ],
        caption: 'Personalized PageRank on the query↔URL bipartite graph via DuckDB recursive-style CTE chain (bounded-unroll power iteration, 25 steps).',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'survival',
    label: 'Survival',
    kind: 'analyzer',
    isQueryGrained: true,
    capabilities: {
      panel: {
        component: SurvivalAnalyzerPanel,
        summarize: ({ meta }) => [
          { label: 'episodes', value: asNumber(meta.totalEpisodes) },
          { label: 'cohorts', value: asNumber(meta.cohortCount) },
          { label: 'window', value: `${asNumber(meta.windowDays, 180)}d` },
        ],
        caption: 'Kaplan-Meier survival curves. S(t) = Π(1 − d/n) computed in SQL via EXP(SUM(LN(...))); at-risk via reverse cumulative sum.',
      },
    },
  }),
  defineGscAnalyzer({ id: 'content-velocity', label: 'Velocity', kind: 'analyzer', isQueryGrained: true, capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'ctr-curve', label: 'CTR curve', kind: 'analyzer', isQueryGrained: true, capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'dark-traffic', label: 'Dark traffic', kind: 'analyzer', capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'device-gap', label: 'Device gap', kind: 'analyzer', capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'keyword-breadth', label: 'Breadth', kind: 'analyzer', isQueryGrained: true, capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'position-distribution', label: 'Position dist.', kind: 'analyzer', capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'trends', label: 'Trends', kind: 'analyzer', isQueryGrained: true, capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({ id: 'zero-click', label: 'Zero-click', kind: 'analyzer', isQueryGrained: true, capabilities: { panel: genericTablePanel } }),
  defineGscAnalyzer({
    id: 'content-gap',
    label: 'Content gaps ✨',
    kind: 'semantic',
    isQueryGrained: true,
    capabilities: {
      panel: {
        component: ContentGapPipelinePanel,
        ownsLifecycle: true,
        caption: 'Embeddings: Xenova/bge-base-en-v1.5 (fp32, 768-dim) via @huggingface/transformers, WebGPU if available.',
      },
    },
  }),
  defineGscAnalyzer({
    id: 'actions',
    label: 'Actions ⚡',
    kind: 'action',
    capabilities: {
      panel: {
        component: ActionsPipelinePanel,
        ownsLifecycle: true,
        caption: 'Actions are deduped across sources — a keyword flagged by both striking-distance and cannibalization surfaces as one action with both source tags.',
      },
    },
  }),
]
