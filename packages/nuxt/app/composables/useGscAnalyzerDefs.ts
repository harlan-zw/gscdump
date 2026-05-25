// Registry of analyzer definitions. The layer owns the type shape and the
// reader; hosts provide the array via a Nuxt plugin (`$gscAnalyzers`) or via
// the module's `analyzers` option (which generates the plugin at build time).
//
// Callers:
//   - `/analyze` page builds its tab list from `useGscAnalyzerDefs()` and
//     renders each tab via `<GscAnalyzerPanel :def>` driven by `panel`.
//   - `/insights` page filters via `useGscAnalyzerDefsWithCapability('insightCard')`.
//   - `useActionPriority` filters via `useGscAnalyzerDefsWithCapability('actionPriority')`.
//
// Capability slots are typed; e.g. `actionPriority` only accepts the
// `ActionSource` union from `@gscdump/analysis`, so misspelt or unknown
// sources fail at typecheck instead of at runtime in the priority runner.

import type { ActionSource } from '@gscdump/analysis'
import type { AnalysisTool } from '@gscdump/engine/analysis-types'
import type { Component } from '@vue/runtime-core'

export type GscAnalyzerKind = 'analyzer' | 'semantic' | 'action'

export type GscAnalyzerAccent = 'primary' | 'warning' | 'success' | 'error' | 'neutral'

export interface GscAnalyzerInsightCard {
  icon: string
  accent: GscAnalyzerAccent
  description: string
  summarize: (res: { results: unknown[], meta: Record<string, unknown> }) => { headline: string, tagline: string }
}

export interface GscAnalyzerStatTile {
  label: string
  value: string | number
  /**
   * Optional CSS color string for the value (used by the few panels that
   *  color-code direction, e.g. improved/worsened in change-points).
   */
  valueColor?: string
}

export interface GscAnalyzerPanelResult {
  results: unknown[]
  meta: Record<string, unknown>
  queryMs?: number | null
}

export interface GscAnalyzerPanelSpec {
  /**
   * Body component. Receives `{ rows, meta, range }` as props. Lazy-import
   *  via `defineAsyncComponent(() => import(...))` to preserve route-level
   *  codesplitting — pages that don't render the analyzer never pay for its
   *  chart code.
   */
  component: Component
  /** Project a result to the header stat tiles. Empty array = no tiles. */
  summarize?: (res: GscAnalyzerPanelResult) => GscAnalyzerStatTile[]
  /** Italic footer caption explaining the underlying method. */
  caption?: string
  /**
   * When true, the shell skips its loading/error/empty gating and renders
   *  the body component immediately — the panel manages its own phase state
   *  (pipeline panels: action priority, content gap).
   */
  ownsLifecycle?: boolean
}

export interface GscAnalyzerCapabilities {
  /** Opt into the `/insights` curated grid by providing a card config. */
  insightCard?: GscAnalyzerInsightCard
  /** Opt into `useActionPriority`. The value is the typed `ActionSource` slug. */
  actionPriority?: ActionSource
  /**
   * Opt into the unified `/analyze` panel renderer. Without this, the tab
   *  falls back to the generic table renderer in `<GscAnalyzerPanel>`.
   */
  panel?: GscAnalyzerPanelSpec
}

export type GscAnalyzerCapability = keyof GscAnalyzerCapabilities

export interface GscAnalyzerDefinition {
  /** Stable analyzer id. Must match an `AnalysisTool` slug for built-in analyzers. */
  id: AnalysisTool | (string & {})
  label: string
  kind: GscAnalyzerKind
  /** Reads the per-query table; sums silently drop GSC-anonymized impressions. */
  isQueryGrained?: boolean
  /** Capability opt-ins. Each key gates a downstream consumer. */
  capabilities?: GscAnalyzerCapabilities
}

export type GscAnalyzerDefinitionWithCapability<K extends GscAnalyzerCapability>
  = GscAnalyzerDefinition & {
    capabilities: { [P in K]: NonNullable<GscAnalyzerCapabilities[P]> }
  }

export function defineGscAnalyzer(def: GscAnalyzerDefinition): GscAnalyzerDefinition {
  return def
}

export function useGscAnalyzerDefs(): GscAnalyzerDefinition[] {
  return (useNuxtApp().$gscAnalyzers as GscAnalyzerDefinition[] | undefined) ?? []
}

export function useGscAnalyzerDef(id: string): GscAnalyzerDefinition | undefined {
  return useGscAnalyzerDefs().find(a => a.id === id)
}

/**
 * Typed filter that narrows defs to those with `capability` opted in.
 * The returned defs have `capabilities[capability]` typed as non-nullable.
 */
export function useGscAnalyzerDefsWithCapability<K extends GscAnalyzerCapability>(
  capability: K,
): GscAnalyzerDefinitionWithCapability<K>[] {
  return useGscAnalyzerDefs().filter(
    (d): d is GscAnalyzerDefinitionWithCapability<K> =>
      d.capabilities?.[capability] != null,
  )
}
