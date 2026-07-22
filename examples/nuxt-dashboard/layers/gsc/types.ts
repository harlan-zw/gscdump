// Minimal type surface for the reference dashboard. The authoritative layer
// lives in nuxtseo.com; this stub only exports what `examples/nuxt-dashboard`
// imports directly.
// TODO: port from nuxtseo.com

import type { ActionSource } from '@gscdump/analysis'
import type { AnalyticsClient } from '@gscdump/sdk/analytics'
import type { $Fetch } from 'ofetch'
import type { Component } from 'vue'

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
  valueColor?: string
}

export interface GscAnalyzerPanelResult {
  results: unknown[]
  meta: Record<string, unknown>
  queryMs?: number | null
}

export interface GscAnalyzerPanelSpec {
  component: Component
  summarize?: (res: GscAnalyzerPanelResult) => GscAnalyzerStatTile[]
  caption?: string
  ownsLifecycle?: boolean
}

export interface GscAnalyzerCapabilities {
  insightCard?: GscAnalyzerInsightCard
  actionPriority?: ActionSource
  panel?: GscAnalyzerPanelSpec
}

export type GscAnalyzerCapability = keyof GscAnalyzerCapabilities

export interface GscAnalyzerDefinition {
  id: string
  label: string
  kind: GscAnalyzerKind
  isQueryGrained?: boolean
  capabilities?: GscAnalyzerCapabilities
}

export type GscAnalyzerDefinitionWithCapability<K extends GscAnalyzerCapability>
  = GscAnalyzerDefinition & {
    capabilities: { [P in K]: NonNullable<GscAnalyzerCapabilities[P]> }
  }

export function defineGscAnalyzer(def: GscAnalyzerDefinition): GscAnalyzerDefinition {
  return def
}

export interface GscAnalyticsRuntimeConfig {
  apiBase: string
  duckdbBundleBase: string
  timezone: string
  toastErrors: boolean
  defaultEngine: 'auto' | 'browser' | 'server'
  mode?: 'local' | 'origin' | 'consumer'
}

declare module '@nuxt/schema' {
  interface PublicRuntimeConfig {
    analytics: GscAnalyticsRuntimeConfig
  }
}

declare module 'nuxt/app' {
  interface NuxtApp {
    $gscAnalytics: unknown
    $gscQueryDispatcher: unknown
    $gscFetch: $Fetch
    $gscAnalyticsClient: AnalyticsClient
    $gscAnalyzers: GscAnalyzerDefinition[]
  }
}
