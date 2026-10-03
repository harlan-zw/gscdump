import type { Result } from './core/result'
import { err, ok } from './core/result'

export interface IndexNowInput { host: string, key: string, keyLocation: string }
export type IndexNowDelivery
  = | { _tag: 'accepted', httpStatus: 200, reason: null, retryAfterMs: null }
    | { _tag: 'pending', httpStatus: 202, reason: 'key-validation-pending', retryAfterMs: null }
    | { _tag: 'rejected', httpStatus: 400 | 403 | 422, reason: string, retryAfterMs: null }
    | { _tag: 'retrying', httpStatus: number, reason: string, retryAfterMs: number | null }
    | { _tag: 'failed', httpStatus: number, reason: string, retryAfterMs: null }
export interface IndexNowInvalidRequest { _tag: 'InvalidRequest', reason: string }
export type IndexNowVerification = { _tag: 'verified' } | { _tag: 'verification-required', reason: string }

function parseUrl(value: string): URL | null {
  return URL.canParse(value) ? new URL(value) : null
}
function parseInput(input: IndexNowInput): Result<URL, IndexNowInvalidRequest> {
  const location = parseUrl(input.keyLocation)
  if (!/^[a-z0-9-]{8,128}$/i.test(input.key))
    return err({ _tag: 'InvalidRequest', reason: 'invalid-key' })
  if (!location || location.protocol !== 'https:' || location.host !== input.host || location.username || location.password || location.hash || location.search || location.port)
    return err({ _tag: 'InvalidRequest', reason: 'invalid-key-location' })
  return ok(location)
}

export interface IndexNowClient {
  verify: (input: IndexNowInput) => Promise<Result<IndexNowVerification, IndexNowInvalidRequest>>
  submit: (input: IndexNowInput & { urls: string[] }) => Promise<Result<IndexNowDelivery, IndexNowInvalidRequest>>
}

export function indexNow(options: { fetch?: typeof globalThis.fetch, clock?: () => Date, timeoutMs?: number } = {}): IndexNowClient {
  const fetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const clock = options.clock ?? (() => new Date())
  return {
    async verify(input: IndexNowInput): Promise<Result<IndexNowVerification, IndexNowInvalidRequest>> {
      const parsed = parseInput(input)
      if (!parsed.ok)
        return parsed
      // Workers supports manual redirects. The status check rejects redirects without following them.
      const response = await fetch(input.keyLocation, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      if (response.status !== 200)
        return ok({ _tag: 'verification-required', reason: 'key-file-unavailable' })
      const reader = response.body?.getReader()
      if (!reader)
        return ok({ _tag: 'verification-required', reason: 'key-file-empty' })
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        const next = await reader.read()
        if (next.done)
          break
        length += next.value.length
        if (length > 1024) {
          await reader.cancel()
          return ok({ _tag: 'verification-required', reason: 'key-file-too-large' })
        }
        chunks.push(next.value)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      return ok(new TextDecoder().decode(bytes).trim() === input.key ? { _tag: 'verified' } : { _tag: 'verification-required', reason: 'key-file-mismatch' })
    },
    async submit(input: IndexNowInput & { urls: string[] }): Promise<Result<IndexNowDelivery, IndexNowInvalidRequest>> {
      const parsed = parseInput(input)
      if (!parsed.ok)
        return parsed
      if (!input.urls.length || input.urls.length > 10_000)
        return err({ _tag: 'InvalidRequest', reason: 'invalid-url-count' })
      const directory = parsed.value.pathname.slice(0, parsed.value.pathname.lastIndexOf('/') + 1)
      for (const value of input.urls) {
        const url = parseUrl(value)
        if (!url || !['https:', 'http:'].includes(url.protocol) || url.host !== input.host || url.username || url.password || url.port || url.hash || !url.pathname.startsWith(directory))
          return err({ _tag: 'InvalidRequest', reason: 'url-outside-key-scope' })
      }
      const response = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: input.host, key: input.key, keyLocation: input.keyLocation, urlList: input.urls }),
      })
      if (response.status === 200)
        return ok({ _tag: 'accepted', httpStatus: 200, reason: null, retryAfterMs: null })
      if (response.status === 202)
        return ok({ _tag: 'pending', httpStatus: 202, reason: 'key-validation-pending', retryAfterMs: null })
      if (response.status === 400 || response.status === 403 || response.status === 422)
        return ok({ _tag: 'rejected', httpStatus: response.status, reason: response.status === 403 ? 'invalid-key' : 'invalid-request', retryAfterMs: null })
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after')
        const seconds = retry === null ? Number.NaN : Number(retry)
        const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : retry === null ? Number.NaN : Date.parse(retry) - clock().getTime()
        return ok({ _tag: 'retrying', httpStatus: response.status, reason: response.status === 429 ? 'rate-limited' : 'service-unavailable', retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay) : null })
      }
      return ok({ _tag: 'failed', httpStatus: response.status, reason: 'unexpected-response', retryAfterMs: null })
    },
  }
}
