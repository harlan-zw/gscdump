// Per-query dispatch policy + fallback telemetry behind one swappable seam.
//
// `useGscQuery` owns *intent* (the caller's `engine: 'auto' | 'browser' | 'server'`);
// the dispatcher owns *policy* (how `auto` resolves against current auth, what
// to do with auto-fallback events). Default impl is no-op telemetry — hosts
// that want fallback beacons override the provide with a configured factory.

import type { _useGscAuthInternal } from './useGscAuth'
import type { GscQueryDecisionReason, GscQueryEngine } from './useGscQuery'
import { useGscEngine } from './useGscEngine'

type InternalAuthState = ReturnType<typeof _useGscAuthInternal>['value']

export interface GscEngineDecision {
  mode: 'browser' | 'server'
  reason: GscQueryDecisionReason
  /** The resolved intent before the auth/optin mapping — useful for callers that branch on "did the user ask for auto?". */
  requested: GscQueryEngine
  detail?: string
}

export interface GscFallbackEvent {
  reason: string
  at: number
  url: string
}

export interface PickEngineOpts {
  /** Per-call override. Wins over `useGscEngine()` + `runtimeConfig.public.analytics.defaultEngine`. */
  perCall?: GscQueryEngine
}

export interface GscQueryDispatcher {
  /**
   * Resolve the active engine into a concrete mode + reason. Consults the
   * resolution chain: `opts.perCall` → `useGscEngine()` → runtimeConfig →
   * `'auto'`. Then maps `auto` against `auth.browserAnalyzerEnabled`.
   */
  pickEngine: (auth: InternalAuthState, opts?: PickEngineOpts) => GscEngineDecision
  /** Called once per auto-fallback. Default impl is a no-op. */
  reportFallback: (event: GscFallbackEvent) => void
}

export interface CreateDefaultDispatcherOpts {
  /** When set, fallbacks beacon to this URL with batched payloads. */
  telemetryEndpoint?: string
}

const FLUSH_DELAY_MS = 5000

function createReporter(endpoint: string): (event: GscFallbackEvent) => void {
  const buffer: GscFallbackEvent[] = []
  let flushScheduled = false

  function flush(): void {
    flushScheduled = false
    if (buffer.length === 0)
      return
    const events = buffer.splice(0)
    const body = JSON.stringify({ events })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }))
      return
    }
    fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json' } }).catch(() => {})
  }

  function scheduleFlush(): void {
    if (flushScheduled || typeof window === 'undefined')
      return
    flushScheduled = true
    setTimeout(flush, FLUSH_DELAY_MS)
    if (typeof document !== 'undefined') {
      const handler = (): void => {
        if (document.visibilityState === 'hidden')
          flush()
      }
      document.addEventListener('visibilitychange', handler, { once: true })
    }
  }

  return (event: GscFallbackEvent): void => {
    buffer.push(event)
    scheduleFlush()
  }
}

export function createDefaultGscQueryDispatcher(
  opts: CreateDefaultDispatcherOpts = {},
): GscQueryDispatcher {
  const reportFallback = opts.telemetryEndpoint
    ? createReporter(opts.telemetryEndpoint)
    : (): void => {}

  return {
    pickEngine(auth, opts = {}): GscEngineDecision {
      const requested = opts.perCall ?? resolveDefaultEngine()
      if (requested === 'server')
        return { mode: 'server', reason: 'forced:server', requested }
      if (requested === 'browser')
        return { mode: 'browser', reason: 'forced:browser', requested }
      // 'auto': when the host has wired setGscAuth, derive from the per-user
      // browserAnalyzerEnabled flag. When unwired, preserve legacy 'auto' = browser.
      if (auth._initialized && !auth.browserAnalyzerEnabled)
        return { mode: 'server', reason: 'optin:off', requested }
      return { mode: 'browser', reason: 'auto:browser', requested }
    },
    reportFallback,
  }
}

function resolveDefaultEngine(): GscQueryEngine {
  const override = useGscEngine().value
  if (override)
    return override
  const cfg = useRuntimeConfig().public.analytics as { defaultEngine?: GscQueryEngine } | undefined
  return cfg?.defaultEngine ?? 'auto'
}

export function useGscQueryDispatcher(): GscQueryDispatcher {
  return useNuxtApp().$gscQueryDispatcher
}
