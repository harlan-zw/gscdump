import type {
  GscdumpV1Operation as ContractGscdumpV1Operation,
  GscdumpV1OperationId as ContractGscdumpV1OperationId,
  createGscdumpV1Protocol,
  GscdumpV1ErrorEnvelope,
  HttpV1OperationDefinition,
  HttpV1Registry,
} from '@gscdump/contracts/v1/http'
import type { z, ZodTypeAny } from 'zod'

type MaybePromise<T> = T | Promise<T>
type ValueOf<T> = T[keyof T]

type GscdumpV1ProtocolShape = ReturnType<typeof createGscdumpV1Protocol>
type GscdumpV1RegistryOperations
  = GscdumpV1ProtocolShape['surfaces']['partner']['operations']
    & GscdumpV1ProtocolShape['surfaces']['analytics']['operations']
    & GscdumpV1ProtocolShape['surfaces']['realtime']['operations']
type GscdumpV1RegistryMethodName = keyof GscdumpV1RegistryOperations & string
interface GscdumpV1ClientMethodAliases {
  queryRows: 'queryAnalyticsRows'
  queryReport: 'queryAnalyticsReport'
  queryReportDetail: 'queryAnalyticsReportDetail'
  getStreamHead: 'getRealtimeStreamHead'
  createTicket: 'createRealtimeTicket'
}
type GscdumpV1ClientMethodFor<TMethod extends GscdumpV1RegistryMethodName>
  = TMethod extends keyof GscdumpV1ClientMethodAliases
    ? GscdumpV1ClientMethodAliases[TMethod]
    : TMethod
type GscdumpV1NamedOperations = {
  [TMethod in GscdumpV1RegistryMethodName as GscdumpV1ClientMethodFor<TMethod>]: GscdumpV1RegistryOperations[TMethod]
}
type GscdumpV1ClientMethodName = keyof GscdumpV1NamedOperations & string

export type GscdumpV1Operation = ContractGscdumpV1Operation
export type GscdumpV1OperationId = ContractGscdumpV1OperationId

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

type MethodId<TMethod extends GscdumpV1ClientMethodName>
  = GscdumpV1NamedOperations[TMethod] extends { id: infer TId extends GscdumpV1OperationId }
    ? TId
    : never

type GscdumpV1OperationMethod<TId extends GscdumpV1OperationId>
  = Record<never, never> extends GscdumpV1OperationInput<TId>
    ? (
        input?: GscdumpV1OperationInput<TId>,
        options?: GscdumpV1ExecuteOptions,
      ) => Promise<GscdumpV1OperationResponse<TId>>
    : (
        input: GscdumpV1OperationInput<TId>,
        options?: GscdumpV1ExecuteOptions,
      ) => Promise<GscdumpV1OperationResponse<TId>>

export type GscdumpV1Client = {
  // `NoInfer` keeps TId inference on the operation id alone — inferring it by
  // reverse-mapping the input against the full operation union trips TS2590
  // once the registry grows past ~30 operations.
  execute: <TId extends GscdumpV1OperationId>(
    operation: TId,
    input: NoInfer<GscdumpV1OperationInput<TId>>,
    options?: GscdumpV1ExecuteOptions,
  ) => Promise<GscdumpV1OperationResponse<TId>>
} & {
  [TMethod in GscdumpV1ClientMethodName]: GscdumpV1OperationMethod<MethodId<TMethod>>
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
  buildOperationPath: (params?: unknown) => string,
  operation: HttpV1OperationDefinition,
  input: Record<string, unknown>,
  options: GscdumpV1ExecuteOptions,
): PreparedRequest {
  let path: string
  if (operation.request.params === null) {
    assertAbsentLocation(operation.id, 'params', input.params)
    path = buildOperationPath()
  }
  else {
    try {
      path = buildOperationPath(input.params)
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

interface GscdumpV1Runtime {
  isUnknownOperationError: (error: unknown) => boolean
  registry: HttpV1Registry<GscdumpV1ProtocolShape>
  protocol: GscdumpV1ProtocolShape
}

let runtimePromise: Promise<GscdumpV1Runtime> | undefined

function getRuntime(): Promise<GscdumpV1Runtime> {
  return runtimePromise ??= import('@gscdump/contracts/v1/http').then(({
    createGscdumpV1Protocol,
    createHttpV1Registry,
    isUnknownHttpV1OperationError,
  }) => {
    const protocol = createGscdumpV1Protocol()
    return {
      isUnknownOperationError: isUnknownHttpV1OperationError,
      protocol,
      registry: createHttpV1Registry(protocol),
    }
  })
}

/** Create one framework-neutral client whose behavior is driven by the v1 registry. */
export function createGscdumpV1Client(options: CreateGscdumpV1ClientOptions): GscdumpV1Client {
  const retryOptions = resolveRetryOptions(options.retry)
  const apiRoot = options.apiRoot ?? DEFAULT_API_ROOT
  const fetchImpl = options.fetch ?? globalThis.fetch

  if (typeof fetchImpl !== 'function')
    throw new TypeError('createGscdumpV1Client requires a fetch implementation in this runtime.')

  // Typed facade over an untyped body: the body only needs the operation
  // descriptor, and keeping the 30+-operation input/response unions out of its
  // expressions avoids TS2590 (union too complex), which grows with every
  // promoted operation. The cast is the only place the generic signature and
  // the erased implementation meet.
  const execute = (executeUntyped as unknown) as GscdumpV1Client['execute']

  async function executeUntyped(
    operationId: GscdumpV1OperationId,
    input: unknown,
    executeOptions: GscdumpV1ExecuteOptions = {},
  ): Promise<unknown> {
    const { isUnknownOperationError, protocol, registry } = await getRuntime()
    const entry = (() => {
      try {
        return registry.operation(operationId)
      }
      catch (cause) {
        if (isUnknownOperationError(cause))
          return null
        throw cause
      }
    })()
    if (!entry) {
      throw new GscdumpV1Error({
        code: 'request_validation',
        message: `Unknown gscdump v1 operation: ${operationId}`,
        retryable: false,
        details: { operationId },
      })
    }
    const { operation } = entry
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw requestValidationError(operation.id, 'input', new TypeError('input must be an object.'))
    // The generic client shell erases params; the registry parses them before serialization.
    const buildRegisteredPath = registry.path as unknown as (
      id: GscdumpV1OperationId,
      params?: unknown,
      options?: { apiRoot?: string },
    ) => string
    const prepared = prepareRequest(
      params => buildRegisteredPath(operationId, params, { apiRoot }),
      operation,
      input as Record<string, unknown>,
      executeOptions,
    )
    let url: string
    try {
      url = appendQuery(prepared.path, prepared.query)
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
          return responseContract.client.parse(payload)
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

  const client: GscdumpV1Client = {
    execute,
    getUserLifecycle: (input, executeOptions) => execute('partner.users.lifecycle.get' satisfies MethodId<'getUserLifecycle'>, input, executeOptions),
    listAvailableSites: (input, executeOptions) => execute('partner.users.sites.available.list' satisfies MethodId<'listAvailableSites'>, input, executeOptions),
    createSite: (input, executeOptions) => execute('partner.users.sites.create' satisfies MethodId<'createSite'>, input, executeOptions),
    createUser: (input, executeOptions) => execute('partner.users.create' satisfies MethodId<'createUser'>, input, executeOptions),
    updateUserTokens: (input, executeOptions) => execute('partner.users.tokens.update' satisfies MethodId<'updateUserTokens'>, input, executeOptions),
    getSiteIndexing: (input, executeOptions) => execute('partner.sites.indexing.get' satisfies MethodId<'getSiteIndexing'>, input, executeOptions),
    listSiteIndexingUrls: (input, executeOptions) => execute('partner.sites.indexing.urls.list' satisfies MethodId<'listSiteIndexingUrls'>, input, executeOptions),
    listSiteBingIndexingEvidence: (input, executeOptions) => execute('partner.sites.indexing.bing.evidence.list' satisfies MethodId<'listSiteBingIndexingEvidence'>, input, executeOptions),
    getSiteBingConnection: (input, executeOptions) => execute('partner.sites.indexing.bing.connection.get' satisfies MethodId<'getSiteBingConnection'>, input, executeOptions),
    verifySiteBingConnection: (input, executeOptions) => execute('partner.sites.indexing.bing.connection.verify' satisfies MethodId<'verifySiteBingConnection'>, input, executeOptions),
    listSiteIndexingTransitions: (input, executeOptions) => execute('partner.sites.indexing.transitions.list' satisfies MethodId<'listSiteIndexingTransitions'>, input, executeOptions),
    getSiteIndexingDiagnostics: (input, executeOptions) => execute('partner.sites.indexing.diagnostics.get' satisfies MethodId<'getSiteIndexingDiagnostics'>, input, executeOptions),
    getSiteSitemaps: (input, executeOptions) => execute('partner.sites.sitemaps.get' satisfies MethodId<'getSiteSitemaps'>, input, executeOptions),
    getSiteSitemapChanges: (input, executeOptions) => execute('partner.sites.sitemaps.changes.get' satisfies MethodId<'getSiteSitemapChanges'>, input, executeOptions),
    listSitemapUrls: (input, executeOptions) => execute('partner.sites.sitemaps.urls.get' satisfies MethodId<'listSitemapUrls'>, input, executeOptions),
    getSitemapExport: (input, executeOptions) => execute('partner.sites.sitemaps.export.get' satisfies MethodId<'getSitemapExport'>, input, executeOptions),
    getSiteAnalysis: (input, executeOptions) => execute('partner.sites.analysis.get' satisfies MethodId<'getSiteAnalysis'>, input, executeOptions),
    getSiteAnalysisBundle: (input, executeOptions) => execute('partner.sites.analysis.bundle.get' satisfies MethodId<'getSiteAnalysisBundle'>, input, executeOptions),
    deleteSite: (input, executeOptions) => execute('partner.sites.delete' satisfies MethodId<'deleteSite'>, input, executeOptions),
    getCanonicalMismatches: (input, executeOptions) => execute('partner.sites.canonical.mismatches.get' satisfies MethodId<'getCanonicalMismatches'>, input, executeOptions),
    inspectSiteUrls: (input, executeOptions) => execute('partner.sites.indexing.inspect.create' satisfies MethodId<'inspectSiteUrls'>, input, executeOptions),
    recoverSitePermission: (input, executeOptions) => execute('partner.sites.permission.recover' satisfies MethodId<'recoverSitePermission'>, input, executeOptions),
    queryKeywordSparklines: (input, executeOptions) => execute('partner.sites.keyword.sparklines.query' satisfies MethodId<'queryKeywordSparklines'>, input, executeOptions),
    getQueryTrend: (input, executeOptions) => execute('partner.sites.query.trend.get' satisfies MethodId<'getQueryTrend'>, input, executeOptions),
    getPageTrend: (input, executeOptions) => execute('partner.sites.page.trend.get' satisfies MethodId<'getPageTrend'>, input, executeOptions),
    getContentVelocity: (input, executeOptions) => execute('partner.sites.content.velocity.get' satisfies MethodId<'getContentVelocity'>, input, executeOptions),
    getCtrCurve: (input, executeOptions) => execute('partner.sites.ctr.curve.get' satisfies MethodId<'getCtrCurve'>, input, executeOptions),
    getDarkTraffic: (input, executeOptions) => execute('partner.sites.dark.traffic.get' satisfies MethodId<'getDarkTraffic'>, input, executeOptions),
    getDeviceGap: (input, executeOptions) => execute('partner.sites.device.gap.get' satisfies MethodId<'getDeviceGap'>, input, executeOptions),
    getKeywordBreadth: (input, executeOptions) => execute('partner.sites.keyword.breadth.get' satisfies MethodId<'getKeywordBreadth'>, input, executeOptions),
    getPositionDistribution: (input, executeOptions) => execute('partner.sites.position.distribution.get' satisfies MethodId<'getPositionDistribution'>, input, executeOptions),
    getTopAssociation: (input, executeOptions) => execute('partner.sites.top.association.get' satisfies MethodId<'getTopAssociation'>, input, executeOptions),
    getIndexPercent: (input, executeOptions) => execute('partner.sites.index.percent.get' satisfies MethodId<'getIndexPercent'>, input, executeOptions),
    createSitemapAction: (input, executeOptions) => execute('partner.sites.sitemaps.action.create' satisfies MethodId<'createSitemapAction'>, input, executeOptions),
    querySitemapMembership: (input, executeOptions) => execute('partner.sites.sitemaps.membership.query' satisfies MethodId<'querySitemapMembership'>, input, executeOptions),
    createTeam: (input, executeOptions) => execute('partner.teams.create' satisfies MethodId<'createTeam'>, input, executeOptions),
    renameTeam: (input, executeOptions) => execute('partner.teams.rename' satisfies MethodId<'renameTeam'>, input, executeOptions),
    deleteTeam: (input, executeOptions) => execute('partner.teams.delete' satisfies MethodId<'deleteTeam'>, input, executeOptions),
    listTeamMembers: (input, executeOptions) => execute('partner.teams.members.list' satisfies MethodId<'listTeamMembers'>, input, executeOptions),
    addTeamMember: (input, executeOptions) => execute('partner.teams.members.add' satisfies MethodId<'addTeamMember'>, input, executeOptions),
    updateTeamMemberRole: (input, executeOptions) => execute('partner.teams.members.role.update' satisfies MethodId<'updateTeamMemberRole'>, input, executeOptions),
    removeTeamMember: (input, executeOptions) => execute('partner.teams.members.remove' satisfies MethodId<'removeTeamMember'>, input, executeOptions),
    updateSiteTeam: (input, executeOptions) => execute('partner.sites.team.update' satisfies MethodId<'updateSiteTeam'>, input, executeOptions),
    getTeamCatalog: (input, executeOptions) => execute('partner.teams.catalog.get' satisfies MethodId<'getTeamCatalog'>, input, executeOptions),
    bindTeamCatalog: (input, executeOptions) => execute('partner.teams.catalog.bind' satisfies MethodId<'bindTeamCatalog'>, input, executeOptions),
    getSiteIntIdCrosswalk: (input, executeOptions) => execute('partner.users.sites.crosswalk.get' satisfies MethodId<'getSiteIntIdCrosswalk'>, input, executeOptions),
    deleteUser: (input, executeOptions) => execute('partner.users.delete' satisfies MethodId<'deleteUser'>, input, executeOptions),
    createVerificationToken: (input, executeOptions) => execute('partner.users.verification.token.create' satisfies MethodId<'createVerificationToken'>, input, executeOptions),
    addAndVerifySite: (input, executeOptions) => execute('partner.users.sites.verify.create' satisfies MethodId<'addAndVerifySite'>, input, executeOptions),
    queryAnalyticsRows: (input, executeOptions) => execute('analytics.rows.query' satisfies MethodId<'queryAnalyticsRows'>, input, executeOptions),
    queryAnalyticsReport: (input, executeOptions) => execute('analytics.reports.query' satisfies MethodId<'queryAnalyticsReport'>, input, executeOptions),
    queryAnalyticsReportDetail: (input, executeOptions) => execute('analytics.reports.detail.query' satisfies MethodId<'queryAnalyticsReportDetail'>, input, executeOptions),
    getRealtimeStreamHead: (input = {}, executeOptions) => execute('realtime.stream.head.get' satisfies MethodId<'getRealtimeStreamHead'>, input, executeOptions),
    createRealtimeTicket: (input, executeOptions) => execute('realtime.tickets.create' satisfies MethodId<'createRealtimeTicket'>, input, executeOptions),
  }
  return client
}
