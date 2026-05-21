/**
 * CONTRACT — consolidated analyzer composable public API (Wave-2, frozen).
 *
 * The single composable that replaces BOTH `useGscAnalyzer.ts` (pkg) and
 * `useBrowserAnalyzer.ts` (app). One OPFS-backed, attach-once, browser-
 * eligibility-aware analyzer.
 *
 * This file is the INTERFACE ONLY — the Wave-2 implementation agent writes
 * `useGscSnapshotAnalyzer.ts` against these types, then deletes the two old
 * composables. Naming follows the package convention (`useGsc*`).
 *
 * Behaviour the types lock in:
 * - ATTACH-ONCE — DuckDB-WASM boots once; OPFS-cached parquet attaches once
 *   per `(site, searchType)`. Filter / date-range changes within the attached
 *   span re-query, they do NOT re-attach.
 * - OPFS-backed — files resolved via the file-resolution endpoint are cached
 *   in OPFS (content-hash verified); steady-state queries are zero-network.
 * - RESULT LRU — identical archetype queries replay from an in-memory LRU.
 * - BROWSER-ELIGIBILITY AWARE — when the file-resolution endpoint returns a
 *   server-tail directive for a table, `query()` for that table transparently
 *   routes server-side; the consumer does not branch.
 *
 * TYPES ONLY — no composable body.
 */

import type { GscSearchType } from '@gscdump/contracts'
import type {
  ArchetypeQuery,
  ArchetypeResult,
  ArchetypeResultRow,
} from '@gscdump/sdk'
import type { MaybeRefOrGetter, Ref } from 'vue'

/** Date window the analyzer is attached over. */
export interface AnalyzerRange {
  start: string
  end: string
}

/** Boot / attach lifecycle phase, surfaced for the progress UI. */
export type AnalyzerPhase
  = | 'idle'
    | 'resolving' // calling the file-resolution endpoint
    | 'booting' // DuckDB-WASM boot
    | 'downloading' // fetching parquet into OPFS
    | 'attaching' // registering OPFS files as DuckDB views
    | 'ready'
    | 'error'

/** Progressive-load progress, drives `<GscBootProgress>`. */
export interface AnalyzerProgress {
  phase: AnalyzerPhase
  /** Files fetched into OPFS so far. */
  filesReady: number
  /** Total files to fetch for the current attach. */
  filesTotal: number
  /** Bytes fetched into OPFS so far. */
  bytesReady: number
  bytesTotal: number
  startedAt?: number
  endedAt?: number
  error?: string
}

/** OPFS storage health, surfaced so the UI can warn before eviction. */
export interface AnalyzerStorageState {
  /** `navigator.storage.persist()` result. `false` => eviction-eligible. */
  persisted: boolean
  /** Estimated bytes used by this origin's OPFS. */
  usageBytes?: number
  /** Estimated quota. */
  quotaBytes?: number
  /** True after a `QuotaExceededError` forced a degraded (server-tail) path. */
  degraded: boolean
}

/**
 * Per-table routing the analyzer resolved. `'browser'` tables answer locally
 * from OPFS; `'server'` tables route to the server tail. Consumers may read
 * this to show "deep history served from the cloud" UX.
 */
export type AnalyzerTableRouting = Record<string, 'browser' | 'server'>

/** Options for `useGscSnapshotAnalyzer`. */
export interface GscSnapshotAnalyzerOptions {
  /** Max entries in the result LRU. Default implementation-defined. */
  resultCacheSize?: number
}

/**
 * The consolidated analyzer instance. Refs are reactive over the currently
 * bound `(site, searchType, range)` — switching any of them rebinds and the
 * refs track the new attach with no manual mirroring.
 */
export interface GscSnapshotAnalyzer {
  /** True once the analyzer can serve `query()` (browser attached OR server-tail ready). */
  ready: Ref<boolean>
  /** True while resolving / booting / attaching. */
  initializing: Ref<boolean>
  error: Ref<Error | null>
  progress: Ref<AnalyzerProgress>
  storage: Ref<AnalyzerStorageState>
  /** Per-table browser vs server routing for the current attach. */
  routing: Ref<AnalyzerTableRouting>
  /** Snapshot version of the currently-attached file set (re-attach trigger). */
  snapshotVersion: Ref<string | undefined>
  /** The site currently bound. */
  currentSiteId: Ref<string | null>

  /**
   * Run a typed archetype query. Routes automatically:
   * - browser-eligible tables → DuckDB-WASM over OPFS files.
   * - server-tail tables      → R2 SQL or server DuckDB per the directive.
   * Identical queries replay from the result LRU. Honours `signal`.
   */
  query: <R extends ArchetypeResultRow = ArchetypeResultRow>(
    q: ArchetypeQuery,
    opts?: { signal?: AbortSignal },
  ) => Promise<ArchetypeResult<R>>

  /**
   * Re-probe the file-resolution endpoint; if `snapshotVersion` changed,
   * detach stale views and re-attach the fresher parquet in place (the
   * DuckDB-WASM runtime stays alive). Resolves true if it re-attached.
   * No-op for fully server-tail-routed sites.
   */
  refresh: () => Promise<boolean>

  /** Drop the result LRU without detaching. Cheap cache bust. */
  clearCache: () => void

  /** Detach views, close the runtime, release OPFS handles. Idempotent. */
  dispose: () => Promise<void>
}

/**
 * Get (or create) the consolidated analyzer for a site. Per-`(site,
 * searchType, range)` cached + refcounted across the app, so panels on the
 * same site share one DuckDB-WASM boot and one OPFS attach.
 *
 * Replaces `useGscAnalyzer` (pkg) and `useBrowserAnalyzer` /
 * `provideBrowserAnalyzer` / `useSharedBrowserAnalyzer` (app) — those are
 * deleted once consumers migrate.
 */
export type UseGscSnapshotAnalyzer = (
  siteId: MaybeRefOrGetter<string | null | undefined>,
  searchType?: MaybeRefOrGetter<GscSearchType | undefined>,
  range?: MaybeRefOrGetter<AnalyzerRange | null | undefined>,
  options?: GscSnapshotAnalyzerOptions,
) => GscSnapshotAnalyzer
