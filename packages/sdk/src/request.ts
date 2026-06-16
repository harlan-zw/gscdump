import type { Result } from 'gscdump/result'
import type { ZodTypeAny } from 'zod'
import type { PartnerApiError } from './errors'
import { err, ok, unwrapResult } from 'gscdump/result'
import { ofetch } from 'ofetch'
import { partnerErrorToException, toPartnerError } from './errors'

export type HostedFetch = <T = unknown>(request: string, options?: HostedFetchOptions) => Promise<T>
export type HostedHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>)

export interface HostedFetchOptions {
  method?: string
  headers?: HeadersInit
  query?: Record<string, unknown>
  body?: unknown
  [key: string]: unknown
}

export interface HostedClientOptions {
  apiBase?: string
  fetch?: HostedFetch
  headers?: HostedHeaders
  validate?: boolean | 'request' | 'response'
}

export interface HostedRequestOptions extends HostedClientOptions {
  apiKey?: string
}

export interface HostedRequester {
  request: <T>(path: string, init?: HostedFetchOptions, responseSchema?: ZodTypeAny) => Promise<T>
  requestResult: <T>(path: string, init?: HostedFetchOptions, responseSchema?: ZodTypeAny) => Promise<Result<T, PartnerApiError>>
  shouldValidate: (phase: 'request' | 'response') => boolean
}

const TRAILING_SLASH_RE = /\/+$/
const LEADING_SLASH_RE = /^\/+/

function trimApiBase(apiBase: string | undefined, fallback: string): string {
  return (apiBase ?? fallback).replace(TRAILING_SLASH_RE, '')
}

function buildPath(apiBase: string, path: string): string {
  if (!apiBase)
    return path.startsWith('/') ? path : `/${path}`
  return `${apiBase}/${path.replace(LEADING_SLASH_RE, '')}`
}

function mergeHeaders(base: HeadersInit | undefined, extra: HeadersInit | undefined): Headers {
  const headers = new Headers(base)
  if (extra) {
    for (const [key, value] of new Headers(extra).entries())
      headers.set(key, value)
  }
  return headers
}

async function resolveHeaders(options: HostedRequestOptions): Promise<HeadersInit | undefined> {
  const resolved = typeof options.headers === 'function'
    ? await options.headers()
    : options.headers
  if (!options.apiKey)
    return resolved
  return mergeHeaders(resolved, { 'x-api-key': options.apiKey })
}

function shouldValidate(options: HostedClientOptions, phase: 'request' | 'response'): boolean {
  return options.validate === true || options.validate === phase
}

function parseWith<T>(schema: ZodTypeAny | undefined, value: T): T {
  return schema ? schema.parse(value) as T : value
}

export function createHostedRequester(
  options: HostedRequestOptions,
  defaults: { apiBase: string },
): HostedRequester {
  const fetchImpl = options.fetch ?? (ofetch as HostedFetch)
  const apiBase = trimApiBase(options.apiBase, defaults.apiBase)

  async function requestResult<T>(
    path: string,
    init: HostedFetchOptions = {},
    responseSchema?: ZodTypeAny,
  ): Promise<Result<T, PartnerApiError>> {
    const headers = mergeHeaders(await resolveHeaders(options), init.headers)
    try {
      const out = await fetchImpl<T>(buildPath(apiBase, path), {
        ...init,
        headers,
      })
      return ok(shouldValidate(options, 'response') ? parseWith(responseSchema, out) : out)
    }
    catch (error) {
      return err(toPartnerError(error))
    }
  }

  async function request<T>(
    path: string,
    init: HostedFetchOptions = {},
    responseSchema?: ZodTypeAny,
  ): Promise<T> {
    return unwrapResult(await requestResult<T>(path, init, responseSchema), partnerErrorToException)
  }

  return {
    request,
    requestResult,
    shouldValidate: (phase: 'request' | 'response') => shouldValidate(options, phase),
  }
}
