// Public API surface of @gscdump/nuxt.
// Anything not exported here is considered internal and may change without a major bump.
//
// This package is a frontend-only Nuxt layer. Server-side primitives (auth
// providers, query sources, GSC API helpers) live in their respective sibling
// packages: `@gscdump/analysis` (sources), `gscdump` (GSC API client), and
// host-specific Nitro server code in the consuming app.

import type { AnalyticsClient } from '@gscdump/sdk'
import type { $Fetch } from 'ofetch'
import type { GscQueryDispatcher } from './app/composables/_useGscQueryDispatcher'
import type { GscAnalyticsContext } from './app/composables/useGscAnalytics'
import type { GscAnalyzerDefinition } from './app/composables/useGscAnalyzerDefs'

export interface GscAnalyticsRuntimeConfig {
  /**
   * Base URL the client uses to reach the analytics API (`/api/__gsc/*`).
   * Empty string = same-origin. Hosts running the layer as a portable client
   * against a remote origin (e.g. an embedded dashboard pointing at
   * https://gscdump.com) set this via `GSCDUMP_ANALYTICS_API_BASE`.
   */
  apiBase: string
  /** Base URL for DuckDB-WASM worker + bundle assets. Empty = layer default. */
  duckdbBundleBase: string
  /** IANA tz name; empty = browser default. */
  timezone: string
  /** When true, layer auto-toasts classified fetch errors via Nuxt UI. */
  toastErrors: boolean
  /** Default engine when caller doesn't pass `opts.engine`. */
  defaultEngine: 'auto' | 'browser' | 'server'
}

declare module '@nuxt/schema' {
  interface PublicRuntimeConfig {
    analytics: GscAnalyticsRuntimeConfig
  }
}

declare module '#app' {
  interface NuxtApp {
    $gscAnalytics: GscAnalyticsContext
    $gscQueryDispatcher: GscQueryDispatcher
    $gscFetch: $Fetch
    $gscAnalyticsClient: AnalyticsClient
    $gscAnalyzers?: GscAnalyzerDefinition[]
  }
}

export type {
  GscAnalyzerBatchEntry,
  GscAnalyzerBatchRunner,
  GscAnalyzerBatchStatus,
  UseGscAnalyzerBatchOptions,
} from './app/composables/useGscAnalyzerBatch'
export { defineGscAnalyzer } from './app/composables/useGscAnalyzerDefs'
export type {
  GscAnalyzerAccent,
  GscAnalyzerCapabilities,
  GscAnalyzerCapability,
  GscAnalyzerDefinition,
  GscAnalyzerDefinitionWithCapability,
  GscAnalyzerInsightCard,
  GscAnalyzerKind,
  GscAnalyzerPanelResult,
  GscAnalyzerPanelSpec,
  GscAnalyzerStatTile,
} from './app/composables/useGscAnalyzerDefs'

export { gscPanelRunnerKey, useGscPanelRunner } from './app/composables/useGscPanelContext'

export type { GscPanelRunnerContext } from './app/composables/useGscPanelContext'
export type {
  UseGscParquetTableOptions,
  UseGscParquetTableReturn,
} from './app/composables/useGscParquetTable'

export type {
  GscBackfillRunner,
  GscQueryDecision,
  GscQueryDecisionReason,
  GscQueryEngine,
  GscQueryMeta,
  GscQueryStatus,
  UseGscQueryOptions,
  UseGscQueryReturn,
} from './app/composables/useGscQuery'

export type { UseGscRollupTableOptions } from './app/composables/useGscRollupTable'

export type {
  AnalysisSourcesResponse,
  CountriesResponse,
  CountryRow,
  GscApiRange,
  GscRowQueryMeta,
  GscRowQueryResponse,
  IndexingDiagnostics,
  IndexingIssue,
  IndexingIssueSeverity,
  IndexingUrlRow,
  IndexingUrlsResponse,
  IndexingUrlStatus,
  InspectionHistoryRecord,
  InspectionHistoryResponse,
  SearchAppearanceResponse,
  SearchAppearanceRow,
  SiteListItem,
  SitemapAddedRow,
  SitemapChangesResponse,
  SitemapHistoryRecord,
  SitemapHistoryResponse,
  SitemapRemovedRow,
  SourceInfoResponse,
} from '@gscdump/contracts'
