// Reactive auth primitive for the @gscdump/nuxt-analytics layer.
//
// Replaces the module-level `_headers` ref + `setGscFetchHeaders` helper with
// SSR-safe `useState`-backed state. Hosts call `setGscAuth(getter)` from a
// `'pre'`-enforced plugin so downstream `useGscFetch`, `useGscQuery`, and
// `useGscAnalyzer` reactively re-read auth on every change (no plugin race).
//
// `apiKey` populates `x-api-key` for cross-origin deployments.
// `apiBase` overrides `runtimeConfig.public.analytics.apiBase` (host-supplied
// origin overrides env-default — useful when one Nuxt app talks to multiple
// data origins).
// `browserAnalyzerEnabled` is the user-level opt-in for DuckDB-WASM; the
// layer's `useGscQuery` reads it when `engine: 'auto'` is requested.

import type { Ref } from 'vue'

export interface GscAuthState {
  apiKey: string | null
  apiBase: string
  browserAnalyzerEnabled: boolean
  userId?: string | null
}

interface InternalAuthState extends GscAuthState {
  /**
   * True once the host has called `setGscAuth` at least once. Layer
   * consumers (e.g. `useGscQuery` engine derivation) treat unconfigured
   * state as "no host wiring" and fall back to legacy behavior, rather
   * than honoring the default `browserAnalyzerEnabled: false`.
   */
  _initialized: boolean
}

const STATE_KEY = 'gsc:auth'

const DEFAULT_AUTH: InternalAuthState = {
  apiKey: null,
  apiBase: '',
  browserAnalyzerEnabled: false,
  userId: null,
  _initialized: false,
}

function authState(): Ref<InternalAuthState> {
  return useState<InternalAuthState>(STATE_KEY, () => ({ ...DEFAULT_AUTH }))
}

export function useGscAuth(): Readonly<Ref<GscAuthState>> {
  return readonly(authState()) as unknown as Readonly<Ref<GscAuthState>>
}

/**
 * Layer-internal: returns the underlying state including `_initialized`.
 * Used by `useGscQuery` to decide whether to honor the host's
 * `browserAnalyzerEnabled` flag or fall back to legacy dispatch.
 */
export function _useGscAuthInternal(): Readonly<Ref<InternalAuthState>> {
  return readonly(authState()) as Readonly<Ref<InternalAuthState>>
}

/**
 * Set the layer's auth state. Accepts a static value, a ref, or a getter.
 * Getter form is reactive — re-runs whenever its source updates (e.g. when
 * the host's `useMe()` swaps in fresh data).
 */
export function setGscAuth(
  source: GscAuthState | Ref<GscAuthState> | (() => GscAuthState),
): void {
  const state = authState()
  const apply = (v: GscAuthState): void => {
    state.value = { ...v, _initialized: true }
  }
  if (typeof source === 'function') {
    watchEffect(() => apply((source as () => GscAuthState)()))
    return
  }
  if (isRef(source)) {
    watch(source, v => apply(v), { immediate: true, deep: true })
    return
  }
  apply(source)
}

/**
 * Read auth state outside of a Vue setup context. Used by `useGscFetch`'s
 * `onRequest` interceptor — that hook fires per request, not at composable
 * setup, so it can't call `useState`. Falls back to the SSR payload state
 * when a Nuxt app is in scope; returns the default otherwise.
 */
export function readGscAuth(): GscAuthState {
  const nuxt = tryUseNuxtApp()
  if (!nuxt)
    return { ...DEFAULT_AUTH }
  const payload = nuxt.payload?.state as Record<string, unknown> | undefined
  const raw = payload?.[`$s${STATE_KEY}`] as InternalAuthState | undefined
  return raw ?? { ...DEFAULT_AUTH }
}
