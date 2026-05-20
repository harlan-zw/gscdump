// Reactive auth primitive for the @gscdump/nuxt layer.
//
// `useState`-backed so the value is SSR-safe and shared across the page tree.
// Hosts call `setGscAuth(getter)` from a `'pre'`-enforced plugin so downstream
// `useGscFetch`, `useGscQuery`, and `useGscAnalyzer` reactively re-read auth
// on every change (no plugin race).
//
// `apiKey` populates `x-api-key` for cross-origin deployments.
// `headers` is an opaque bag for hosts that need additional/alternative
// auth schemes (e.g. `Authorization: Bearer …`, CSRF). Merged after `apiKey`.
// `browserAnalyzerEnabled` is the user-level opt-in for DuckDB-WASM.
//
// `apiBase` is *not* on this state — it's a build-time runtimeConfig value
// (`runtimeConfig.public.analytics.apiBase`). Per-user dynamic apiBase would
// reintroduce a plugin-order race where the SDK client gets a stale prefix.

import type { Ref } from '@vue/runtime-core'

export interface GscAuthState {
  apiKey: string | null
  browserAnalyzerEnabled: boolean
  userId?: string | null
  /**
   * Extra request headers to attach to every `/api/__gsc/*` call and parquet
   * fetch. Use for non-`x-api-key` auth schemes. `apiKey` (above) is the
   * common case — set both when needed.
   */
  headers?: Record<string, string>
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
  browserAnalyzerEnabled: false,
  userId: null,
  headers: undefined,
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
 */
export function _useGscAuthInternal(): Readonly<Ref<InternalAuthState>> {
  return readonly(authState()) as Readonly<Ref<InternalAuthState>>
}

/**
 * Set the layer's auth state. Accepts a static value, a ref, or a getter.
 * Getter form is reactive — re-runs whenever its source updates.
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
 * Read auth state from any callsite — composable setup, fetch interceptor,
 * worker fetch callback. Resolves the ambient NuxtApp via async-local-storage
 * (server) or the global app (client) and reads the `useState` cell directly.
 * Returns the default sentinel when no NuxtApp context is available.
 */
export function readGscAuth(): GscAuthState {
  const nuxt = tryUseNuxtApp()
  if (!nuxt)
    return { ...DEFAULT_AUTH }
  return authState().value
}

/**
 * Resolve the auth headers to attach to a request — `x-api-key` from `apiKey`
 * (if set) merged with the opaque `headers` bag. Returns `{}` when no auth
 * is wired, signalling callers to fall back to cookie credentials.
 */
export function resolveGscAuthHeaders(auth: GscAuthState = readGscAuth()): Record<string, string> {
  const out: Record<string, string> = {}
  if (auth.apiKey)
    out['x-api-key'] = auth.apiKey
  if (auth.headers) {
    for (const [k, v] of Object.entries(auth.headers))
      out[k] = v
  }
  return out
}
