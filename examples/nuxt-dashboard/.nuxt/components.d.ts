
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


export const ActionPriorityPanel: typeof import("../app/components/ActionPriorityPanel.vue")['default']
export const AnomalyChart: typeof import("../app/components/AnomalyChart.vue")['default']
export const BayesianCtrPanel: typeof import("../app/components/BayesianCtrPanel.vue")['default']
export const BipartitePageRankPanel: typeof import("../app/components/BipartitePageRankPanel.vue")['default']
export const CannibalizationGraph: typeof import("../app/components/CannibalizationGraph.vue")['default']
export const ChangePointPanel: typeof import("../app/components/ChangePointPanel.vue")['default']
export const ContentGapPanel: typeof import("../app/components/ContentGapPanel.vue")['default']
export const IntentTreemap: typeof import("../app/components/IntentTreemap.vue")['default']
export const LongTailFingerprint: typeof import("../app/components/LongTailFingerprint.vue")['default']
export const MigrationSankey: typeof import("../app/components/MigrationSankey.vue")['default']
export const ResultTable: typeof import("../app/components/ResultTable.vue")['default']
export const StlPanel: typeof import("../app/components/StlPanel.vue")['default']
export const SurvivalPanel: typeof import("../app/components/SurvivalPanel.vue")['default']
export const TimingPanel: typeof import("../app/components/TimingPanel.vue")['default']
export const VolatilityHeatmap: typeof import("../app/components/VolatilityHeatmap.vue")['default']
export const NuxtWelcome: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/welcome.vue")['default']
export const NuxtLayout: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-layout")['default']
export const NuxtErrorBoundary: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-error-boundary.vue")['default']
export const ClientOnly: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/client-only")['default']
export const DevOnly: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/dev-only")['default']
export const ServerPlaceholder: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/server-placeholder")['default']
export const NuxtLink: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-link")['default']
export const NuxtLoadingIndicator: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-loading-indicator")['default']
export const NuxtTime: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-time.vue")['default']
export const NuxtRouteAnnouncer: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-route-announcer")['default']
export const NuxtAnnouncer: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-announcer")['default']
export const NuxtImg: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-stubs")['NuxtImg']
export const NuxtPicture: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-stubs")['NuxtPicture']
export const NuxtPage: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/pages/runtime/page")['default']
export const NoScript: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['NoScript']
export const Link: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Link']
export const Base: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Base']
export const Title: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Title']
export const Meta: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Meta']
export const Style: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Style']
export const Head: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Head']
export const Html: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Html']
export const Body: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Body']
export const NuxtIsland: typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-island")['default']
export const LazyActionPriorityPanel: LazyComponent<typeof import("../app/components/ActionPriorityPanel.vue")['default']>
export const LazyAnomalyChart: LazyComponent<typeof import("../app/components/AnomalyChart.vue")['default']>
export const LazyBayesianCtrPanel: LazyComponent<typeof import("../app/components/BayesianCtrPanel.vue")['default']>
export const LazyBipartitePageRankPanel: LazyComponent<typeof import("../app/components/BipartitePageRankPanel.vue")['default']>
export const LazyCannibalizationGraph: LazyComponent<typeof import("../app/components/CannibalizationGraph.vue")['default']>
export const LazyChangePointPanel: LazyComponent<typeof import("../app/components/ChangePointPanel.vue")['default']>
export const LazyContentGapPanel: LazyComponent<typeof import("../app/components/ContentGapPanel.vue")['default']>
export const LazyIntentTreemap: LazyComponent<typeof import("../app/components/IntentTreemap.vue")['default']>
export const LazyLongTailFingerprint: LazyComponent<typeof import("../app/components/LongTailFingerprint.vue")['default']>
export const LazyMigrationSankey: LazyComponent<typeof import("../app/components/MigrationSankey.vue")['default']>
export const LazyResultTable: LazyComponent<typeof import("../app/components/ResultTable.vue")['default']>
export const LazyStlPanel: LazyComponent<typeof import("../app/components/StlPanel.vue")['default']>
export const LazySurvivalPanel: LazyComponent<typeof import("../app/components/SurvivalPanel.vue")['default']>
export const LazyTimingPanel: LazyComponent<typeof import("../app/components/TimingPanel.vue")['default']>
export const LazyVolatilityHeatmap: LazyComponent<typeof import("../app/components/VolatilityHeatmap.vue")['default']>
export const LazyNuxtWelcome: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/welcome.vue")['default']>
export const LazyNuxtLayout: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-layout")['default']>
export const LazyNuxtErrorBoundary: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-error-boundary.vue")['default']>
export const LazyClientOnly: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/client-only")['default']>
export const LazyDevOnly: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/dev-only")['default']>
export const LazyServerPlaceholder: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/server-placeholder")['default']>
export const LazyNuxtLink: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-link")['default']>
export const LazyNuxtLoadingIndicator: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-loading-indicator")['default']>
export const LazyNuxtTime: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-time.vue")['default']>
export const LazyNuxtRouteAnnouncer: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-route-announcer")['default']>
export const LazyNuxtAnnouncer: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-announcer")['default']>
export const LazyNuxtImg: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-stubs")['NuxtImg']>
export const LazyNuxtPicture: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-stubs")['NuxtPicture']>
export const LazyNuxtPage: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/pages/runtime/page")['default']>
export const LazyNoScript: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['NoScript']>
export const LazyLink: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Link']>
export const LazyBase: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Base']>
export const LazyTitle: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Title']>
export const LazyMeta: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Meta']>
export const LazyStyle: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Style']>
export const LazyHead: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Head']>
export const LazyHtml: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Html']>
export const LazyBody: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/head/runtime/components")['Body']>
export const LazyNuxtIsland: LazyComponent<typeof import("../../../node_modules/.pnpm/nuxt@4.4.2_@babel+core@7.29.0_@babel+plugin-syntax-jsx@7.28.6_@babel+core@7.29.0__@emna_6635f9cd633ee1bd3fa811d4988c4b05/node_modules/nuxt/dist/app/components/nuxt-island")['default']>

export const componentNames: string[]
