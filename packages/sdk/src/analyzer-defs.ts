// Analyzer definition types + the `defineGscAnalyzer` identity helper.
//
// Framework-agnostic: the `panel.component` slot is typed as `unknown` here
// (consumers narrow it to their framework's component type — e.g. Vue's
// `Component`) so SDK stays free of vue/react imports.
//
// Capability slots are typed; e.g. `actionPriority` only accepts the
// `ActionSource` union from `@gscdump/analysis`, so misspelt sources fail at
// typecheck rather than at runtime in the priority runner.

import type { ActionSource } from '@gscdump/analysis'
import type { AnalysisTool } from '@gscdump/engine/analysis-types'

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
  /** Optional CSS color for the value (e.g. improved/worsened in change-points). */
  valueColor?: string
}

export interface GscAnalyzerPanelResult {
  results: unknown[]
  meta: Record<string, unknown>
  queryMs?: number | null
}

export interface GscAnalyzerPanelSpec<TComponent = unknown> {
  /**
   * Body component. Receives `{ rows, meta, range }` as props. Lazy-import
   * to preserve route-level codesplitting.
   *
   * Typed `unknown` in the SDK; consumers can narrow via generic
   * (`GscAnalyzerDefinition<VueComponent>`).
   */
  component: TComponent
  /** Project a result to the header stat tiles. Empty array = no tiles. */
  summarize?: (res: GscAnalyzerPanelResult) => GscAnalyzerStatTile[]
  /** Italic footer caption explaining the underlying method. */
  caption?: string
  /**
   * When true, the shell skips its loading/error/empty gating and renders
   * the body component immediately (pipeline panels: action priority, content gap).
   */
  ownsLifecycle?: boolean
}

export interface GscAnalyzerCapabilities<TComponent = unknown> {
  /** Opt into the `/insights` curated grid by providing a card config. */
  insightCard?: GscAnalyzerInsightCard
  /** Opt into `useActionPriority`. The value is the typed `ActionSource` slug. */
  actionPriority?: ActionSource
  /**
   * Opt into the unified `/analyze` panel renderer. Without this, the tab
   * falls back to the generic table renderer.
   */
  panel?: GscAnalyzerPanelSpec<TComponent>
}

export type GscAnalyzerCapability = keyof GscAnalyzerCapabilities

export interface GscAnalyzerDefinition<TComponent = unknown> {
  /** Stable analyzer id. Must match an `AnalysisTool` slug for built-in analyzers. */
  id: AnalysisTool | (string & {})
  label: string
  kind: GscAnalyzerKind
  /** Reads the per-query table; sums silently drop GSC-anonymized impressions. */
  isQueryGrained?: boolean
  /** Capability opt-ins. Each key gates a downstream consumer. */
  capabilities?: GscAnalyzerCapabilities<TComponent>
}

export type GscAnalyzerDefinitionWithCapability<K extends GscAnalyzerCapability, TComponent = unknown>
  = GscAnalyzerDefinition<TComponent> & {
    capabilities: { [P in K]: NonNullable<GscAnalyzerCapabilities<TComponent>[P]> }
  }

export function defineGscAnalyzer<TComponent = unknown>(
  def: GscAnalyzerDefinition<TComponent>,
): GscAnalyzerDefinition<TComponent> {
  return def
}
