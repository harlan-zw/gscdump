// Configured $fetch instance for the layer's `/api/__gsc/*` calls.
//
// When `runtimeConfig.public.analytics.apiBase` is set, requests are routed
// to that origin (e.g. `https://gscdump.com`). Empty = same-origin, the
// default for self-hosted deployments (gscdump.com itself).
//
// Cross-origin auth: hosts call `setGscFetchHeaders({ 'x-api-key': '…' })`
// from a Nuxt plugin once they've resolved the viewer's origin credentials.
// When headers are set, `credentials: 'include'` is dropped (cookies aren't
// needed). When headers are empty, the layer falls back to cookies, which
// matches the in-origin (same-site) deployment shape.
//
// Type: returns the looser ofetch `$Fetch` rather than Nuxt's
// `NitroFetchRequest`-narrowed `$fetch`. The host's discovered routes don't
// know about `/api/__gsc/*` (handlers live on the remote origin), so the
// Nitro narrowing would mis-type every call site.

import type { $Fetch } from 'ofetch'
import { classifyGscError } from './gsc-error'

let cached: $Fetch | null = null
const _headers = ref<Record<string, string>>({})

const TOAST_DEDUP_MS = 5000
const _recentToasts = new Map<string, number>()

function shouldEmitToast(key: string): boolean {
  const now = Date.now()
  const last = _recentToasts.get(key) ?? 0
  if (now - last < TOAST_DEDUP_MS)
    return false
  _recentToasts.set(key, now)
  // Cap entries so the map never grows unbounded.
  if (_recentToasts.size > 32) {
    const oldest = [..._recentToasts.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest)
      _recentToasts.delete(oldest[0])
  }
  return true
}

function defaultToastTitle(status: string): string {
  switch (status) {
    case 'auth-missing': return 'Sign in required'
    case 'rate-limited': return 'Rate limit exceeded'
    case 'network': return 'Network error'
    default: return 'Request failed'
  }
}

/**
 * Set request headers the layer should attach to every `/api/__gsc/*` call.
 * Hosts call this from a Nuxt plugin after fetching the viewer's origin
 * credentials. Pass `{}` to clear and revert to cookie-credentials.
 */
export function setGscFetchHeaders(headers: Record<string, string>): void {
  _headers.value = headers
}

/**
 * Read the headers set via `setGscFetchHeaders`. Used by `useGscAnalyzer`
 * to authenticate raw parquet fetches in `attachParquetUrlTables` (which
 * bypasses `useGscFetch` since DuckDB-WASM's runtime fetches are decoupled
 * from the layer's $fetch instance).
 */
export function getGscFetchHeaders(): Record<string, string> {
  return _headers.value
}

export function useGscFetch(): $Fetch {
  if (cached)
    return cached
  const cfg = useRuntimeConfig().public.analytics as { apiBase?: string, toastErrors?: boolean } | undefined
  const apiBase = cfg?.apiBase ?? ''
  const toastErrors = cfg?.toastErrors === true
  cached = $fetch.create({
    baseURL: apiBase,
    onRequest: ({ options }) => {
      const extra = _headers.value
      const hasExtra = Object.keys(extra).length > 0
      if (hasExtra) {
        const merged = new Headers(options.headers as HeadersInit | undefined)
        for (const [k, v] of Object.entries(extra))
          merged.set(k, v)
        options.headers = merged
        // Cookies aren't useful when the host supplies an explicit auth header
        // (cross-origin call against a different session realm).
        if (!options.credentials)
          options.credentials = 'omit'
      }
      else if (apiBase && !options.credentials) {
        // No explicit auth headers — fall back to cookies for cross-origin
        // session-backed deployments.
        options.credentials = 'include'
      }
    },
    onResponseError: (ctx) => {
      if (!toastErrors || !import.meta.client)
        return
      const c = classifyGscError(ctx.error ?? ctx.response)
      const key = `${c.status}:${c.code ?? '-'}:${c.message ?? ''}`
      if (!shouldEmitToast(key))
        return
      const toast = useToast()
      toast.add({
        title: defaultToastTitle(c.status),
        description: c.message,
        color: c.status === 'rate-limited' ? 'warning' : 'error',
      })
    },
  }) as unknown as $Fetch
  return cached
}
