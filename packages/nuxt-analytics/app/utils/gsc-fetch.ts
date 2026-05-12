// Configured $fetch instance for the layer's `/api/__gsc/*` calls.
//
// When `runtimeConfig.public.analytics.apiBase` is set, requests are routed
// to that origin (e.g. `https://gscdump.com`). Empty = same-origin, the
// default for self-hosted deployments (gscdump.com itself).
//
// Auth: resolved via `useGscAuth` (host calls `setGscAuth` from a `'pre'`
// plugin). `apiKey` populates `x-api-key`; `headers` carries any additional
// auth headers. When no auth is wired, the layer falls back to cookies for
// same-site / cookie-credentials deployments.
//
// Built once per NuxtApp by the layer plugin and provided as `$gscFetch`.
// `useGscFetch()` is a thin reader; hosts override by providing their own
// `$gscFetch` from a later plugin.

import type { $Fetch } from 'ofetch'
import { readGscAuth, resolveGscAuthHeaders } from '../composables/useGscAuth'
import { classifyGscError } from './gsc-error'

const TOAST_DEDUP_MS = 5000

interface ToastDedup {
  recent: Map<string, number>
}

function shouldEmitToast(dedup: ToastDedup, key: string): boolean {
  const now = Date.now()
  const last = dedup.recent.get(key) ?? 0
  if (now - last < TOAST_DEDUP_MS)
    return false
  dedup.recent.set(key, now)
  if (dedup.recent.size > 32) {
    const oldest = [...dedup.recent.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest)
      dedup.recent.delete(oldest[0])
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

export function createGscFetch(cfgApiBase: string, toastErrors: boolean): $Fetch {
  const dedup: ToastDedup = { recent: new Map() }
  return $fetch.create({
    onRequest: ({ options }) => {
      const auth = readGscAuth()
      const apiBase = cfgApiBase ?? ''
      const authHeaders = resolveGscAuthHeaders(auth)

      const merged = new Headers(options.headers as HeadersInit | undefined)
      for (const [k, v] of Object.entries(authHeaders))
        merged.set(k, v)
      options.headers = merged

      if (apiBase && typeof options.baseURL !== 'string')
        options.baseURL = apiBase

      const hasAuth = Object.keys(authHeaders).length > 0
      if (hasAuth) {
        if (!options.credentials)
          options.credentials = 'omit'
      }
      else if (apiBase && !options.credentials) {
        // No explicit auth — fall back to cookies for cross-origin sessions.
        options.credentials = 'include'
      }
    },
    onResponseError: (ctx) => {
      if (!toastErrors || !import.meta.client)
        return
      const c = classifyGscError(ctx.error ?? ctx.response)
      const key = `${c.status}:${c.code ?? '-'}:${c.message ?? ''}`
      if (!shouldEmitToast(dedup, key))
        return
      const toast = useToast()
      toast.add({
        title: defaultToastTitle(c.status),
        description: c.message,
        color: c.status === 'rate-limited' ? 'warning' : 'error',
      })
    },
  }) as unknown as $Fetch
}

export function useGscFetch(): $Fetch {
  return useNuxtApp().$gscFetch as $Fetch
}
