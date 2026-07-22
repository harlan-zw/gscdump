import type {
  GscdumpV1ErrorEnvelope,
  HttpV1OperationDefinition,
  HttpV1Surface,
} from '@gscdump/contracts/v1'
import type { z, ZodTypeAny } from 'zod'
import {
  buildHttpOperationPath,
  createGscdumpV1Protocol,
} from '@gscdump/contracts/v1'

type MaybePromise<T> = T | Promise<T>
type ValueOf<T> = T[keyof T]
type ValueOfUnion<T> = T extends unknown ? ValueOf<T> : never

type GscdumpV1ProtocolShape = ReturnType<typeof createGscdumpV1Protocol>
type GscdumpV1Surface = ValueOf<GscdumpV1ProtocolShape['surfaces']>
type GscdumpV1OperationRegistry = GscdumpV1Surface['operations']

export type GscdumpV1Operation = ValueOfUnion<GscdumpV1OperationRegistry>
export type GscdumpV1OperationId = GscdumpV1Operation['id']

type OperationById<TId extends GscdumpV1OperationId> = Extract<GscdumpV1Operation, { id: TId }>
type SchemaInput<TSchema> = TSchema extends ZodTypeAny ? z.input<TSchema> : never
type SchemaOutput<TSchema> = TSchema extends ZodTypeAny ? z.output<TSchema> : never
type RequiredLocation<TKey extends string, TSchema> = TSchema extends ZodTypeAny
  ? { [K in TKey]: SchemaInput<TSchema> }
  : { [K in TKey]?: never }
type OptionalLocation<TKey extends string, TSchema> = TSchema extends ZodTypeAny
  ? { [K in TKey]?: SchemaInput<TSchema> }
  : { [K in TKey]?: never }

export type GscdumpV1OperationInput<TId extends GscdumpV1OperationId>
  = RequiredLocation<'params', OperationById<TId>['request']['params']>
    & RequiredLocation<'query', OperationById<TId>['request']['query']>
    & OptionalLocation<'headers', OperationById<TId>['request']['headers']>
    & RequiredLocation<'body', OperationById<TId>['request']['body']>

type OperationResponseSchema<TId extends GscdumpV1OperationId>
  = ValueOf<OperationById<TId>['responses']> extends infer TResponse
    ? TResponse extends { client: infer TClient extends ZodTypeAny }
      ? TClient
      : never
    : never

export type GscdumpV1OperationResponse<TId extends GscdumpV1OperationId>
  = SchemaOutput<OperationResponseSchema<TId>>

export type GscdumpV1CredentialResolver = string | (() => MaybePromise<string>)
export type GscdumpV1HeadersResolver = HeadersInit | (() => MaybePromise<HeadersInit>)

export interface GscdumpV1RetryOptions {
  /** Total attempts, including the initial request. Defaults to 3 and is capped at 5. */
  maxAttempts?: number
  /** Deterministic exponential-backoff base. Defaults to 250 ms. */
  baseDelayMs?: number
  /** Backoff ceiling. Defaults to 2 seconds. Retry-After can exceed this ceiling. */
  maxDelayMs?: number
}

export interface CreateGscdumpV1ClientOptions {
  /**
   * Root replacing the contract's `/api` segment. Direct calls default to
   * `https://gscdump.com/api`; a same-origin proxy can use `/api/_gscdump`.
   */
  apiRoot?: string
  credential: GscdumpV1CredentialResolver
  fetch?: typeof fetch
  headers?: GscdumpV1HeadersResolver
  retry?: GscdumpV1RetryOptions
}

export interface GscdumpV1ExecuteOptions {
  signal?: AbortSignal
  requestId?: string
  idempotencyKey?: string
}

export type GscdumpV1SdkErrorCode
  = GscdumpV1ErrorEnvelope['error']['code']
    | 'aborted'
    | 'credential_resolution'
    | 'network_error'
    | 'protocol_error'
    | 'request_validation'
    | 'response_validation'

export interface GscdumpV1ErrorOptions {
  code: GscdumpV1SdkErrorCode
  message: string
  status?: number
  requestId?: string
  retryable: boolean
  details: Record<string, unknown>
  cause?: unknown
}

/** One stable, tagged failure shape for validation, transport, and API errors. */
export class GscdumpV1Error extends Error {
  readonly tag = 'GscdumpV1Error' as const
  readonly code: GscdumpV1SdkErrorCode
  readonly status?: number
  readonly requestId?: string
  readonly retryable: boolean
  readonly details: Record<string, unknown>
  override readonly cause?: unknown

  constructor(options: GscdumpV1ErrorOptions) {
    super(options.message)
    this.name = 'GscdumpV1Error'
    this.code = options.code
    this.status = options.status
    this.requestId = options.requestId
    this.retryable = options.retryable
    this.details = options.details
    this.cause = options.cause
  }
}

export function isGscdumpV1Error(error: unknown): error is GscdumpV1Error {
  return error instanceof GscdumpV1Error
}

export interface GscdumpV1Client {
  execute: <TId extends GscdumpV1OperationId>(
    operation: TId,
    input: GscdumpV1OperationInput<TId>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<TId>>
  getUserLifecycle: (
    input: GscdumpV1OperationInput<'partner.users.lifecycle.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.users.lifecycle.get'>>
  listAvailableSites: (
    input: GscdumpV1OperationInput<'partner.users.sites.available.list'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.users.sites.available.list'>>
  createSite: (
    input: GscdumpV1OperationInput<'partner.users.sites.create'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.users.sites.create'>>
  createUser: (
    input: GscdumpV1OperationInput<'partner.users.create'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.users.create'>>
  updateUserTokens: (
    input: GscdumpV1OperationInput<'partner.users.tokens.update'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.users.tokens.update'>>
  getSiteIndexing: (
    input: GscdumpV1OperationInput<'partner.sites.indexing.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.indexing.get'>>
  listSiteIndexingUrls: (
    input: GscdumpV1OperationInput<'partner.sites.indexing.urls.list'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.indexing.urls.list'>>
  getSiteIndexingDiagnostics: (
    input: GscdumpV1OperationInput<'partner.sites.indexing.diagnostics.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.indexing.diagnostics.get'>>
  getSiteSitemaps: (
    input: GscdumpV1OperationInput<'partner.sites.sitemaps.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.sitemaps.get'>>
  getSiteSitemapChanges: (
    input: GscdumpV1OperationInput<'partner.sites.sitemaps.changes.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.sitemaps.changes.get'>>
  getSiteAnalysis: (
    input: GscdumpV1OperationInput<'partner.sites.analysis.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.analysis.get'>>
  getSiteAnalysisBundle: (
    input: GscdumpV1OperationInput<'partner.sites.analysis.bundle.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.analysis.bundle.get'>>
  deleteSite: (
    input: GscdumpV1OperationInput<'partner.sites.delete'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.delete'>>
  getCanonicalMismatches: (
    input: GscdumpV1OperationInput<'partner.sites.canonical.mismatches.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.canonical.mismatches.get'>>
  inspectSiteUrls: (
    input: GscdumpV1OperationInput<'partner.sites.indexing.inspect.create'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.indexing.inspect.create'>>
  recoverSitePermission: (
    input: GscdumpV1OperationInput<'partner.sites.permission.recover'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.permission.recover'>>
  queryKeywordSparklines: (
    input: GscdumpV1OperationInput<'partner.sites.keyword.sparklines.query'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.keyword.sparklines.query'>>
  getQueryTrend: (
    input: GscdumpV1OperationInput<'partner.sites.query.trend.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.query.trend.get'>>
  getPageTrend: (
    input: GscdumpV1OperationInput<'partner.sites.page.trend.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'partner.sites.page.trend.get'>>
  queryAnalyticsRows: (
    input: GscdumpV1OperationInput<'analytics.rows.query'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'analytics.rows.query'>>
  queryAnalyticsReport: (
    input: GscdumpV1OperationInput<'analytics.reports.query'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'analytics.reports.query'>>
  queryAnalyticsReportDetail: (
    input: GscdumpV1OperationInput<'analytics.reports.detail.query'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'analytics.reports.detail.query'>>
  getRealtimeStreamHead: (
    input?: GscdumpV1OperationInput<'realtime.stream.head.get'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'realtime.stream.head.get'>>
  createRealtimeTicket: (
    input: GscdumpV1OperationInput<'realtime.tickets.create'>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<'realtime.tickets.create'>>
}

interface ResolvedRetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

interface PreparedRequest {
  body: unknown
  headers: Record<string, unknown>
  path: string
  query: unknown
}

const DEFAULT_API_ROOT = 'https://gscdump.com/api'
const API_PREFIX_RE = /^\/api(?=\/)/
const TRAILING_SLASH_RE = /\/+$/
const LEADING_SLASH_RE = /^\/+/

function validationDetails(cause: unknown): Record<string, unknown> {
  if (typeof cause === 'object' && cause !== null && 'issues' in cause)
    return { issues: (cause as { issues: unknown }).issues }
  return {}
}

function requestValidationError(operationId: string, location: string, cause: unknown): GscdumpV1Error {
  return new GscdumpV1Error({
    code: 'request_validation',
    message: `${operationId}: invalid request ${location}`,
    retryable: false,
    details: { location, ...validationDetails(cause) },
    cause,
  })
}

function responseValidationError(
  operationId: string,
  status: number,
  requestId: string | undefined,
  cause: unknown,
): GscdumpV1Error {
  return new GscdumpV1Error({
    code: 'response_validation',
    message: `${operationId}: response ${status} did not match the v1 contract`,
    status,
    requestId,
    retryable: false,
    details: validationDetails(cause),
    cause,
  })
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined)
    return fallback
  if (!Number.isFinite(value))
    throw new TypeError('Retry configuration values must be finite numbers.')
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function resolveRetryOptions(options: GscdumpV1RetryOptions | undefined): ResolvedRetryOptions {
  const baseDelayMs = clampInteger(options?.baseDelayMs, 250, 0, 60_000)
  const maxDelayMs = clampInteger(options?.maxDelayMs, 2_000, baseDelayMs, 300_000)
  return {
    maxAttempts: clampInteger(options?.maxAttempts, 3, 1, 5),
    baseDelayMs,
    maxDelayMs,
  }
}

function resolveApiUrl(apiRoot: string, contractPath: string): string {
  const relative = contractPath.replace(API_PREFIX_RE, '').replace(LEADING_SLASH_RE, '')
  return `${apiRoot.replace(TRAILING_SLASH_RE, '')}/${relative}`
}

function appendQueryValue(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined)
    return
  if (Array.isArray(value)) {
    for (const item of value)
      appendQueryValue(search, key, item)
    return
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    search.append(key, value === null ? 'null' : String(value))
    return
  }
  search.append(key, JSON.stringify(value))
}

function appendQuery(url: string, query: unknown): string {
  if (query === undefined || query === null)
    return url
  if (typeof query !== 'object' || Array.isArray(query))
    throw new TypeError('A query schema must produce an object.')
  const search = new URLSearchParams()
  for (const key of Object.keys(query as Record<string, unknown>).sort())
    appendQueryValue(search, key, (query as Record<string, unknown>)[key])
  const serialized = search.toString()
  return serialized ? `${url}?${serialized}` : url
}

function assertAbsentLocation(operationId: string, location: string, value: unknown): void {
  if (value !== undefined) {
    throw requestValidationError(
      operationId,
      location,
      new TypeError(`${location} is not accepted by this operation.`),
    )
  }
}

function parseLocation(
  operation: HttpV1OperationDefinition,
  location: 'body' | 'headers' | 'query',
  value: unknown,
): unknown {
  const schema = operation.request[location]
  if (schema === null) {
    assertAbsentLocation(operation.id, location, value)
    return undefined
  }
  try {
    return schema.parse(location === 'headers' && value === undefined ? {} : value)
  }
  catch (cause) {
    throw requestValidationError(operation.id, location, cause)
  }
}

function prepareRequest(
  surface: HttpV1Surface,
  operation: HttpV1OperationDefinition,
  input: Record<string, unknown>,
  options: GscdumpV1ExecuteOptions,
): PreparedRequest {
  let path: string
  if (operation.request.params === null) {
    assertAbsentLocation(operation.id, 'params', input.params)
    path = buildHttpOperationPath(surface, operation)
  }
  else {
    try {
      // buildHttpOperationPath performs the one strict params parse and then
      // serializes that parsed output into the template.
      path = buildHttpOperationPath(surface, operation, input.params)
    }
    catch (cause) {
      throw requestValidationError(operation.id, 'params', cause)
    }
  }

  const inputHeaders = input.headers as Record<string, unknown> | undefined
  const headerRequestId = inputHeaders?.['x-request-id']
  if (options.requestId && headerRequestId && options.requestId !== headerRequestId) {
    throw requestValidationError(
      operation.id,
      'headers',
      new TypeError('requestId conflicts with headers.x-request-id.'),
    )
  }
  const requestHeaders = options.requestId
    ? { ...(inputHeaders ?? {}), 'x-request-id': options.requestId }
    : input.headers

  return {
    path,
    query: parseLocation(operation, 'query', input.query),
    headers: parseLocation(operation, 'headers', requestHeaders) as Record<string, unknown>,
    body: parseLocation(operation, 'body', input.body),
  }
}

async function resolveCredential(resolver: GscdumpV1CredentialResolver): Promise<string> {
  let credential: unknown
  try {
    credential = typeof resolver === 'function' ? await resolver() : resolver
  }
  catch (cause) {
    throw new GscdumpV1Error({
      code: 'credential_resolution',
      message: 'Could not resolve the v1 Bearer credential.',
      retryable: false,
      details: {},
      cause,
    })
  }
  if (typeof credential !== 'string' || !credential.trim()) {
    throw new GscdumpV1Error({
      code: 'credential_resolution',
      message: 'The v1 Bearer credential cannot be empty.',
      retryable: false,
      details: {},
    })
  }
  return credential
}

async function resolveBaseHeaders(resolver: GscdumpV1HeadersResolver | undefined): Promise<HeadersInit | undefined> {
  return typeof resolver === 'function' ? await resolver() : resolver
}

async function buildRequestHeaders(
  options: CreateGscdumpV1ClientOptions,
  operation: HttpV1OperationDefinition,
  prepared: PreparedRequest,
  executeOptions: GscdumpV1ExecuteOptions,
): Promise<Headers> {
  try {
    // Header and credential resolvers are independent and may each perform I/O
    // (session lookup, token refresh, secrets fetch). Start both together so
    // request setup costs the slower resolver rather than their combined time.
    const [baseHeaders, credential] = await Promise.all([
      resolveBaseHeaders(options.headers),
      resolveCredential(options.credential),
    ])
    const headers = new Headers(baseHeaders)
    for (const [key, value] of Object.entries(prepared.headers)) {
      if (value !== undefined)
        headers.set(key, String(value))
    }
    headers.delete('x-api-key')
    headers.set('accept', 'application/json')
    headers.set('authorization', `Bearer ${credential}`)
    if (executeOptions.idempotencyKey)
      headers.set('idempotency-key', executeOptions.idempotencyKey)
    if (prepared.body !== undefined)
      headers.set('content-type', 'application/json')
    return headers
  }
  catch (cause) {
    if (cause instanceof GscdumpV1Error)
      throw cause
    throw requestValidationError(operation.id, 'headers', cause)
  }
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
}

function abortedRequestError(
  operation: HttpV1OperationDefinition,
  executeOptions: GscdumpV1ExecuteOptions,
  cause: unknown = executeOptions.signal?.reason,
): GscdumpV1Error {
  return new GscdumpV1Error({
    code: 'aborted',
    message: `${operation.id}: request aborted`,
    requestId: executeOptions.requestId,
    retryable: false,
    details: {},
    cause,
  })
}

async function waitForRetry(
  ms: number,
  operation: HttpV1OperationDefinition,
  executeOptions: GscdumpV1ExecuteOptions,
): Promise<void> {
  try {
    await sleep(ms, executeOptions.signal)
  }
  catch (cause) {
    if (isAbortError(cause, executeOptions.signal))
      throw abortedRequestError(operation, executeOptions, cause)
    throw cause
  }
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  operation: HttpV1OperationDefinition,
  executeOptions: GscdumpV1ExecuteOptions,
): Promise<T> {
  const signal = executeOptions.signal
  if (!signal)
    return promise
  if (signal.aborted)
    return Promise.reject(abortedRequestError(operation, executeOptions))

  return new Promise<T>((resolve, reject) => {
    function onAbort(): void {
      reject(abortedRequestError(operation, executeOptions))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (cause) => {
        signal.removeEventListener('abort', onAbort)
        reject(cause)
      },
    )
  })
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null)
    return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1_000)
  const date = Date.parse(value)
  if (Number.isNaN(date))
    return undefined
  return Math.max(0, date - now)
}

function retryDelay(
  attempt: number,
  retryAfter: string | null,
  options: ResolvedRetryOptions,
): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  return Math.max(exponential, parseRetryAfter(retryAfter, Date.now()) ?? 0)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(handle)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text)
    return null
  return JSON.parse(text) as unknown
}

function requestIdFrom(response: Response): string | undefined {
  return response.headers.get('x-request-id') ?? undefined
}

function operationLookup(protocol: GscdumpV1ProtocolShape): Map<GscdumpV1OperationId, {
  operation: GscdumpV1Operation
  surface: GscdumpV1Surface
}> {
  const operations = new Map<GscdumpV1OperationId, {
    operation: GscdumpV1Operation
    surface: GscdumpV1Surface
  }>()
  for (const surface of Object.values(protocol.surfaces)) {
    for (const operation of Object.values(surface.operations)) {
      operations.set(operation.id as GscdumpV1OperationId, {
        operation: operation as GscdumpV1Operation,
        surface,
      })
    }
  }
  return operations
}

/** Create one framework-neutral client whose behavior is driven by the v1 registry. */
export function createGscdumpV1Client(options: CreateGscdumpV1ClientOptions): GscdumpV1Client {
  const protocol = createGscdumpV1Protocol()
  const operations = operationLookup(protocol)
  const retryOptions = resolveRetryOptions(options.retry)
  const apiRoot = options.apiRoot ?? DEFAULT_API_ROOT
  const fetchImpl = options.fetch ?? globalThis.fetch

  if (typeof fetchImpl !== 'function')
    throw new TypeError('createGscdumpV1Client requires a fetch implementation in this runtime.')

  async function execute<TId extends GscdumpV1OperationId>(
    operationId: TId,
    input: GscdumpV1OperationInput<TId>,
    executeOptions: GscdumpV1ExecuteOptions = {},
  ): Promise<GscdumpV1OperationResponse<TId>> {
    const entry = operations.get(operationId)
    if (!entry) {
      throw new GscdumpV1Error({
        code: 'request_validation',
        message: `Unknown gscdump v1 operation: ${operationId}`,
        retryable: false,
        details: { operationId },
      })
    }
    const { operation, surface } = entry
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw requestValidationError(operation.id, 'input', new TypeError('input must be an object.'))
    const prepared = prepareRequest(
      surface,
      operation,
      input as Record<string, unknown>,
      executeOptions,
    )
    let url: string
    try {
      url = appendQuery(resolveApiUrl(apiRoot, prepared.path), prepared.query)
    }
    catch (cause) {
      throw requestValidationError(operation.id, 'query', cause)
    }
    const canRetry = operation.semantics.retry === 'idempotent'

    for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt++) {
      if (executeOptions.signal?.aborted) {
        throw abortedRequestError(operation, executeOptions)
      }

      const headers = await awaitWithAbort(
        buildRequestHeaders(options, operation, prepared, executeOptions),
        operation,
        executeOptions,
      )
      if (executeOptions.signal?.aborted)
        throw abortedRequestError(operation, executeOptions)

      let response: Response
      try {
        response = await fetchImpl(url, {
          method: operation.method,
          headers,
          body: prepared.body === undefined ? undefined : JSON.stringify(prepared.body),
          signal: executeOptions.signal,
        })
      }
      catch (cause) {
        if (isAbortError(cause, executeOptions.signal)) {
          throw abortedRequestError(operation, executeOptions, cause)
        }
        if (canRetry && attempt < retryOptions.maxAttempts) {
          await waitForRetry(retryDelay(attempt, null, retryOptions), operation, executeOptions)
          continue
        }
        throw new GscdumpV1Error({
          code: 'network_error',
          message: `${operation.id}: network request failed`,
          requestId: executeOptions.requestId,
          retryable: canRetry,
          details: { attempts: attempt },
          cause,
        })
      }

      const requestId = requestIdFrom(response) ?? executeOptions.requestId
      let payload: unknown
      try {
        payload = await readJson(response)
      }
      catch (cause) {
        if (isAbortError(cause, executeOptions.signal))
          throw abortedRequestError(operation, executeOptions, cause)
        throw responseValidationError(operation.id, response.status, requestId, cause)
      }
      if (executeOptions.signal?.aborted)
        throw abortedRequestError(operation, executeOptions)

      const responseContract = (operation.responses as HttpV1OperationDefinition['responses'])[response.status]
      if (responseContract) {
        try {
          return responseContract.client.parse(payload) as GscdumpV1OperationResponse<TId>
        }
        catch (cause) {
          throw responseValidationError(operation.id, response.status, requestId, cause)
        }
      }

      if (response.ok) {
        throw new GscdumpV1Error({
          code: 'protocol_error',
          message: `${operation.id}: undeclared success status ${response.status}`,
          status: response.status,
          requestId,
          retryable: false,
          details: { status: response.status },
        })
      }

      let envelope: GscdumpV1ErrorEnvelope
      try {
        envelope = protocol.schemas.errorEnvelope.client.parse(payload)
      }
      catch (cause) {
        throw responseValidationError(operation.id, response.status, requestId, cause)
      }
      if (!(operation.errors as readonly string[]).includes(envelope.error.code)) {
        throw new GscdumpV1Error({
          code: 'protocol_error',
          message: `${operation.id}: undeclared error code ${envelope.error.code}`,
          status: response.status,
          requestId: envelope.error.requestId,
          retryable: false,
          details: { code: envelope.error.code },
        })
      }

      const apiError = new GscdumpV1Error({
        code: envelope.error.code,
        message: envelope.error.message,
        status: response.status,
        requestId: envelope.error.requestId,
        retryable: envelope.error.retryable,
        details: envelope.error.details ?? {},
      })
      if (canRetry && apiError.retryable && attempt < retryOptions.maxAttempts) {
        await waitForRetry(
          retryDelay(attempt, response.headers.get('retry-after'), retryOptions),
          operation,
          executeOptions,
        )
        continue
      }
      throw apiError
    }

    throw new GscdumpV1Error({
      code: 'network_error',
      message: `${operationId}: retry budget exhausted`,
      retryable: false,
      details: {},
    })
  }

  return {
    execute,
    getUserLifecycle: (input, executeOptions) => execute('partner.users.lifecycle.get', input, executeOptions),
    listAvailableSites: (input, executeOptions) => execute('partner.users.sites.available.list', input, executeOptions),
    createSite: (input, executeOptions) => execute('partner.users.sites.create', input, executeOptions),
    createUser: (input, executeOptions) => execute('partner.users.create', input, executeOptions),
    updateUserTokens: (input, executeOptions) => execute('partner.users.tokens.update', input, executeOptions),
    getSiteIndexing: (input, executeOptions) => execute('partner.sites.indexing.get', input, executeOptions),
    listSiteIndexingUrls: (input, executeOptions) => execute('partner.sites.indexing.urls.list', input, executeOptions),
    getSiteIndexingDiagnostics: (input, executeOptions) => execute('partner.sites.indexing.diagnostics.get', input, executeOptions),
    getSiteSitemaps: (input, executeOptions) => execute('partner.sites.sitemaps.get', input, executeOptions),
    getSiteSitemapChanges: (input, executeOptions) => execute('partner.sites.sitemaps.changes.get', input, executeOptions),
    getSiteAnalysis: (input, executeOptions) => execute('partner.sites.analysis.get', input, executeOptions),
    getSiteAnalysisBundle: (input, executeOptions) => execute('partner.sites.analysis.bundle.get', input, executeOptions),
    deleteSite: (input, executeOptions) => execute('partner.sites.delete', input, executeOptions),
    getCanonicalMismatches: (input, executeOptions) => execute('partner.sites.canonical.mismatches.get', input, executeOptions),
    inspectSiteUrls: (input, executeOptions) => execute('partner.sites.indexing.inspect.create', input, executeOptions),
    recoverSitePermission: (input, executeOptions) => execute('partner.sites.permission.recover', input, executeOptions),
    queryKeywordSparklines: (input, executeOptions) => execute('partner.sites.keyword.sparklines.query', input, executeOptions),
    getQueryTrend: (input, executeOptions) => execute('partner.sites.query.trend.get', input, executeOptions),
    getPageTrend: (input, executeOptions) => execute('partner.sites.page.trend.get', input, executeOptions),
    queryAnalyticsRows: (input, executeOptions) => execute('analytics.rows.query', input, executeOptions),
    queryAnalyticsReport: (input, executeOptions) => execute('analytics.reports.query', input, executeOptions),
    queryAnalyticsReportDetail: (input, executeOptions) => execute('analytics.reports.detail.query', input, executeOptions),
    getRealtimeStreamHead: (input = {}, executeOptions) => execute('realtime.stream.head.get', input, executeOptions),
    createRealtimeTicket: (input, executeOptions) => execute('realtime.tickets.create', input, executeOptions),
  }
}
