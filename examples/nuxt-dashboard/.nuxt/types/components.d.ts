
import type { DefineComponent, SlotsType } from 'vue'
type IslandComponent<T> = DefineComponent<{}, {refresh: () => Promise<void>}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, SlotsType<{ fallback: { error: unknown } }>> & T

type HydrationStrategies = {
  hydrateOnVisible?: IntersectionObserverInit | true
  hydrateOnIdle?: number | true
  hydrateOnInteraction?: keyof HTMLElementEventMap | Array<keyof HTMLElementEventMap> | true
  hydrateOnMediaQuery?: string
  hydrateAfter?: number
  hydrateWhen?: boolean
  hydrateNever?: true
}
type LazyComponent<T> = DefineComponent<HydrationStrategies, {}, {}, {}, {}, {}, {}, { hydrated: () => void }> & T

interface _GlobalComponents {
  ActionPriorityPanel: typeof import("../../app/components/ActionPriorityPanel.vue")['default']
  AnomalyChart: typeof import("../../app/components/AnomalyChart.vue")['default']
  BayesianCtrPanel: typeof import("../../app/components/BayesianCtrPanel.vue")['default']
  BipartitePageRankPanel: typeof import("../../app/components/BipartitePageRankPanel.vue")['default']
  CannibalizationGraph: typeof import("../../app/components/CannibalizationGraph.vue")['default']
  ChangePointPanel: typeof import("../../app/components/ChangePointPanel.vue")['default']
  ContentGapPanel: typeof import("../../app/components/ContentGapPanel.vue")['default']
  IntentTreemap: typeof import("../../app/components/IntentTreemap.vue")['default']
  LongTailFingerprint: typeof import("../../app/components/LongTailFingerprint.vue")['default']
  MigrationSankey: typeof import("../../app/components/MigrationSankey.vue")['default']
  ResultTable: typeof import("../../app/components/ResultTable.vue")['default']
  Sparkline: typeof import("../../app/components/Sparkline.vue")['default']
  StlPanel: typeof import("../../app/components/StlPanel.vue")['default']
  SurvivalPanel: typeof import("../../app/components/SurvivalPanel.vue")['default']
  TimingPanel: typeof import("../../app/components/TimingPanel.vue")['default']
  VolatilityHeatmap: typeof import("../../app/components/VolatilityHeatmap.vue")['default']
  NuxtWelcome: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/welcome.vue")['default']
  NuxtLayout: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-layout")['default']
  NuxtErrorBoundary: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-error-boundary.vue")['default']
  ClientOnly: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/client-only")['default']
  DevOnly: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/dev-only")['default']
  ServerPlaceholder: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/server-placeholder")['default']
  NuxtLink: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-link")['default']
  NuxtLoadingIndicator: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-loading-indicator")['default']
  NuxtTime: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-time.vue")['default']
  NuxtRouteAnnouncer: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-route-announcer")['default']
  NuxtAnnouncer: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-announcer")['default']
  NuxtImg: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-stubs")['NuxtImg']
  NuxtPicture: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-stubs")['NuxtPicture']
  NuxtPage: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/pages/runtime/page")['default']
  NoScript: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['NoScript']
  Link: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Link']
  Base: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Base']
  Title: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Title']
  Meta: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Meta']
  Style: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Style']
  Head: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Head']
  Html: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Html']
  Body: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Body']
  NuxtIsland: typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-island")['default']
  LazyActionPriorityPanel: LazyComponent<typeof import("../../app/components/ActionPriorityPanel.vue")['default']>
  LazyAnomalyChart: LazyComponent<typeof import("../../app/components/AnomalyChart.vue")['default']>
  LazyBayesianCtrPanel: LazyComponent<typeof import("../../app/components/BayesianCtrPanel.vue")['default']>
  LazyBipartitePageRankPanel: LazyComponent<typeof import("../../app/components/BipartitePageRankPanel.vue")['default']>
  LazyCannibalizationGraph: LazyComponent<typeof import("../../app/components/CannibalizationGraph.vue")['default']>
  LazyChangePointPanel: LazyComponent<typeof import("../../app/components/ChangePointPanel.vue")['default']>
  LazyContentGapPanel: LazyComponent<typeof import("../../app/components/ContentGapPanel.vue")['default']>
  LazyIntentTreemap: LazyComponent<typeof import("../../app/components/IntentTreemap.vue")['default']>
  LazyLongTailFingerprint: LazyComponent<typeof import("../../app/components/LongTailFingerprint.vue")['default']>
  LazyMigrationSankey: LazyComponent<typeof import("../../app/components/MigrationSankey.vue")['default']>
  LazyResultTable: LazyComponent<typeof import("../../app/components/ResultTable.vue")['default']>
  LazySparkline: LazyComponent<typeof import("../../app/components/Sparkline.vue")['default']>
  LazyStlPanel: LazyComponent<typeof import("../../app/components/StlPanel.vue")['default']>
  LazySurvivalPanel: LazyComponent<typeof import("../../app/components/SurvivalPanel.vue")['default']>
  LazyTimingPanel: LazyComponent<typeof import("../../app/components/TimingPanel.vue")['default']>
  LazyVolatilityHeatmap: LazyComponent<typeof import("../../app/components/VolatilityHeatmap.vue")['default']>
  LazyNuxtWelcome: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/welcome.vue")['default']>
  LazyNuxtLayout: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-layout")['default']>
  LazyNuxtErrorBoundary: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-error-boundary.vue")['default']>
  LazyClientOnly: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/client-only")['default']>
  LazyDevOnly: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/dev-only")['default']>
  LazyServerPlaceholder: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/server-placeholder")['default']>
  LazyNuxtLink: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-link")['default']>
  LazyNuxtLoadingIndicator: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-loading-indicator")['default']>
  LazyNuxtTime: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-time.vue")['default']>
  LazyNuxtRouteAnnouncer: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-route-announcer")['default']>
  LazyNuxtAnnouncer: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-announcer")['default']>
  LazyNuxtImg: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-stubs")['NuxtImg']>
  LazyNuxtPicture: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-stubs")['NuxtPicture']>
  LazyNuxtPage: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/pages/runtime/page")['default']>
  LazyNoScript: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['NoScript']>
  LazyLink: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Link']>
  LazyBase: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Base']>
  LazyTitle: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Title']>
  LazyMeta: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Meta']>
  LazyStyle: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Style']>
  LazyHead: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Head']>
  LazyHtml: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Html']>
  LazyBody: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Body']>
  LazyNuxtIsland: LazyComponent<typeof import("../../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-island")['default']>
}

declare module 'vue' {
  export interface GlobalComponents extends _GlobalComponents { }
}

export {}
