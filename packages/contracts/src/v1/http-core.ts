import type { ZodRawShape, ZodTypeAny } from 'zod'
import { z } from 'zod'

export { GSCDUMP_HTTP_V1_VERSION } from './version'

export const HTTP_V1_SURFACES = ['partner', 'analytics', 'realtime'] as const
export const HTTP_V1_METHODS = ['DELETE', 'GET', 'PATCH', 'POST'] as const
export const HTTP_V1_CREDENTIALS = ['user_key', 'partner_key'] as const
const HTTP_V1_USER_KEY_SCOPES = [
  'users:read',
  'users:write',
  'sites:read',
  'sites:write',
  'analytics:read',
  'analytics:execute',
  'indexing:read',
  'indexing:write',
  'sitemaps:read',
  'sitemaps:write',
  'settings:read',
  'settings:write',
  'realtime:connect',
] as const

export const HTTP_V1_SCOPES = [
  ...HTTP_V1_USER_KEY_SCOPES,
  'teams:read',
  'teams:write',
] as const

export const HTTP_V1_CREDENTIAL_SCOPES = {
  user_key: HTTP_V1_USER_KEY_SCOPES,
  partner_key: HTTP_V1_SCOPES,
} as const satisfies Record<typeof HTTP_V1_CREDENTIALS[number], readonly typeof HTTP_V1_SCOPES[number][]>

export const HTTP_V1_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'user_not_found',
  'site_not_found',
  'rate_limited',
  'realtime_unavailable',
  'internal_error',
  'contract_violation',
] as const

export type HttpV1SurfaceName = typeof HTTP_V1_SURFACES[number]
export type HttpV1Method = typeof HTTP_V1_METHODS[number]
export type HttpV1Credential = typeof HTTP_V1_CREDENTIALS[number]
export type HttpV1Scope = typeof HTTP_V1_SCOPES[number]
export type HttpV1ErrorCode = typeof HTTP_V1_ERROR_CODES[number]
export type HttpV1Visibility = 'internal' | 'public'
export type HttpV1OwnershipRule = 'self' | 'linked_user' | 'authorized_site' | 'partner_tenant' | 'principal_stream'
export type HttpV1ResourceType
  = | 'partner.user'
    | 'partner.team'
    | 'user.sites'
    | 'site.registration'
    | 'site.lifecycle'
    | 'site.analytics'
    | 'site.sitemaps'
    | 'site.indexing'
    | 'site.auth'

export interface CompatibleResponseSchema<
  TProducer extends ZodTypeAny = ZodTypeAny,
  TClient extends ZodTypeAny = ZodTypeAny,
> {
  producer: TProducer
  client: TClient
}

export interface HttpV1RequestSchemas {
  params: ZodTypeAny | null
  query: ZodTypeAny | null
  headers: ZodTypeAny | null
  body: ZodTypeAny | null
}

export interface HttpV1Semantics {
  kind: 'mutation' | 'query'
  sideEffects: 'none' | 'state'
  idempotent: boolean
  retry: 'idempotent' | 'never'
  readConsistency: 'primary' | 'replica-ok' | null
}

export interface HttpV1ResourceReference {
  type: HttpV1ResourceType
  idFrom: `params.${string}` | 'principal.id'
}

export interface HttpV1OperationDefinition {
  id: string
  method: HttpV1Method
  path: `/${string}`
  visibility: HttpV1Visibility
  semantics: HttpV1Semantics
  auth: {
    credentials: readonly HttpV1Credential[]
    scopes: readonly HttpV1Scope[]
    ownership: readonly {
      credential: HttpV1Credential
      rule: HttpV1OwnershipRule
    }[]
  }
  request: HttpV1RequestSchemas
  responses: Readonly<Record<number, CompatibleResponseSchema>>
  errors: readonly HttpV1ErrorCode[]
  errorResponse: CompatibleResponseSchema
  resources: {
    reads: readonly HttpV1ResourceReference[]
    changes: readonly HttpV1ResourceReference[]
  }
  lifecycle: {
    introduced: `${number}.${number}.${number}`
    deprecated?: `${number}.${number}.${number}`
    sunset?: string
  }
  docs: {
    summary: string
    description: string
    tags: readonly string[]
    examples: {
      request: unknown
      response: unknown
    }
  }
}

export interface HttpV1Surface<
  TOperations extends Readonly<Record<string, HttpV1OperationDefinition>> = Readonly<Record<string, HttpV1OperationDefinition>>,
> {
  name: HttpV1SurfaceName
  prefix: `/api/${HttpV1SurfaceName}/v1`
  version: '1.0'
  operations: TOperations
}

export interface HttpV1ProtocolLike {
  surfaces: Readonly<Record<string, HttpV1Surface>>
}

type HttpV1ProtocolSurface<TProtocol extends HttpV1ProtocolLike>
  = TProtocol['surfaces'][keyof TProtocol['surfaces']]

type HttpV1SurfaceOperation<TSurface>
  = TSurface extends HttpV1Surface<infer TOperations>
    ? TOperations[keyof TOperations]
    : never

export type HttpV1ProtocolOperation<TProtocol extends HttpV1ProtocolLike>
  = HttpV1SurfaceOperation<HttpV1ProtocolSurface<TProtocol>>

export type HttpV1OperationEntry<TProtocol extends HttpV1ProtocolLike = HttpV1ProtocolLike>
  = HttpV1ProtocolSurface<TProtocol> extends infer TSurface
    ? TSurface extends HttpV1Surface
      ? {
          surface: TSurface
          operation: HttpV1SurfaceOperation<TSurface>
        }
      : never
    : never

export interface HttpV1OperationRequest {
  method: string
  surface: string
  /** Surface-relative path without a leading slash or query string. */
  path: string
}

export type ResolvedHttpV1Operation<TEntry extends HttpV1OperationEntry = HttpV1OperationEntry>
  = TEntry & {
    params: Record<string, unknown>
    /** Canonical surface-relative path. */
    path: string
  }

export type HttpV1RegistryOperationId<TProtocol extends HttpV1ProtocolLike>
  = HttpV1ProtocolOperation<TProtocol>['id'] & string

type HttpV1OperationEntryWithId<TEntry, TId extends string>
  = TEntry extends {
    surface: infer TSurface extends HttpV1Surface
    operation: infer TOperation extends HttpV1OperationDefinition
  }
    ? TOperation extends { id: TId }
      ? { surface: TSurface, operation: TOperation }
      : never
    : never

export type HttpV1RegistryOperationEntry<
  TProtocol extends HttpV1ProtocolLike,
  TId extends HttpV1RegistryOperationId<TProtocol>,
> = HttpV1OperationEntryWithId<HttpV1OperationEntry<TProtocol>, TId>

export interface HttpV1RegistryPathOptions {
  /** Root replacing the contract's `/api` segment. */
  apiRoot?: string
}

export interface HttpV1Registry<TProtocol extends HttpV1ProtocolLike> {
  operation: <const TId extends HttpV1RegistryOperationId<TProtocol>>(
    id: TId,
  ) => HttpV1RegistryOperationEntry<TProtocol, TId>
  resolve: <const TAllowed extends readonly HttpV1RegistryOperationId<TProtocol>[]>(
    request: HttpV1OperationRequest,
    options: { allow: TAllowed },
  ) => ResolvedHttpV1Operation<HttpV1RegistryOperationEntry<TProtocol, TAllowed[number]>> | null
  path: <const TId extends HttpV1RegistryOperationId<TProtocol>>(
    id: TId,
    params?: unknown,
    options?: HttpV1RegistryPathOptions,
  ) => string
}

function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!)
}

function matchHttpOperationPathParameters(
  operation: HttpV1OperationDefinition,
  path: string,
): Record<string, unknown> | null {
  const templateSegments = operation.path.slice(1).split('/')
  const pathSegments = path.split('/')
  if (templateSegments.length !== pathSegments.length)
    return null

  const params: Record<string, string> = {}
  for (let index = 0; index < templateSegments.length; index++) {
    const templateSegment = templateSegments[index]!
    const pathSegment = pathSegments[index]!
    const parameter = /^\{([^{}]+)\}$/.exec(templateSegment)?.[1]
    if (!parameter) {
      if (templateSegment !== pathSegment)
        return null
      continue
    }

    const decoded = (() => {
      try {
        return decodeURIComponent(pathSegment)
      }
      catch {
        return null
      }
    })()
    if (decoded === null
      || decoded.length === 0
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')) {
      return null
    }
    params[parameter] = decoded
  }

  if (operation.request.params === null)
    return Object.keys(params).length === 0 ? {} : null
  const parsed = operation.request.params.safeParse(params)
  if (!parsed.success || parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data))
    return null
  return parsed.data as Record<string, unknown>
}

function isSafePathTemplate(path: string): boolean {
  return /^\/(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?|\{[a-z][A-Za-z0-9]*\})(?:\/(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?|\{[a-z][A-Za-z0-9]*\}))*$/.test(path)
}

function objectSchemaKeys(schema: ZodTypeAny): string[] | null {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : null
}

function assertRequestLocations(request: HttpV1RequestSchemas, operationId: string): void {
  for (const location of ['params', 'query', 'headers', 'body'] as const) {
    if (!(location in request) || request[location] === undefined)
      throw new TypeError(`${operationId}: request.${location} must be a schema or null`)
  }
}

function assertPathContract(operation: HttpV1OperationDefinition): void {
  const names = pathParameterNames(operation.path)
  if (new Set(names).size !== names.length)
    throw new TypeError(`${operation.id}: path parameters must be unique`)

  if (names.length === 0) {
    if (operation.request.params !== null)
      throw new TypeError(`${operation.id}: params must be null when the path has no parameters`)
    return
  }

  if (operation.request.params === null)
    throw new TypeError(`${operation.id}: path parameters require a params schema`)

  const schemaKeys = objectSchemaKeys(operation.request.params)
  if (!schemaKeys)
    throw new TypeError(`${operation.id}: params must be an object schema`)
  if (names.join('\0') !== schemaKeys.join('\0')) {
    throw new TypeError(
      `${operation.id}: params schema keys (${schemaKeys.join(', ')}) must match path order (${names.join(', ')})`,
    )
  }
}

function assertOperation(operation: HttpV1OperationDefinition): void {
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(operation.id))
    throw new TypeError(`${operation.id}: operation ID must be a stable dotted lowercase identifier`)
  if (!isSafePathTemplate(operation.path))
    throw new TypeError(`${operation.id}: path must be a safe literal surface-relative template`)

  assertRequestLocations(operation.request, operation.id)
  assertPathContract(operation)

  if (operation.semantics.kind === 'query') {
    if (operation.semantics.sideEffects !== 'none')
      throw new TypeError(`${operation.id}: query operations cannot declare state side effects`)
    if (!operation.semantics.idempotent)
      throw new TypeError(`${operation.id}: query operations must be idempotent`)
    if (operation.semantics.readConsistency === null)
      throw new TypeError(`${operation.id}: query operations must declare read consistency`)
  }
  else {
    if (operation.semantics.sideEffects !== 'state')
      throw new TypeError(`${operation.id}: mutation operations must declare state side effects`)
    if (operation.semantics.readConsistency !== null)
      throw new TypeError(`${operation.id}: mutations cannot declare read consistency`)
  }

  if (operation.auth.credentials.includes('user_key')
    && operation.semantics.kind === 'query'
    && operation.semantics.readConsistency !== 'primary') {
    throw new TypeError(`${operation.id}: user_key queries must use primary consistency`)
  }

  if (operation.semantics.idempotent && operation.semantics.retry !== 'idempotent')
    throw new TypeError(`${operation.id}: idempotent operations must use the idempotent retry policy`)
  if (!operation.semantics.idempotent && operation.semantics.retry !== 'never')
    throw new TypeError(`${operation.id}: non-idempotent operations cannot be retried automatically`)
  if (operation.auth.credentials.length === 0 || operation.auth.scopes.length === 0)
    throw new TypeError(`${operation.id}: auth credentials and scopes are required`)
  for (const credential of operation.auth.credentials) {
    const availableScopes: readonly HttpV1Scope[] = HTTP_V1_CREDENTIAL_SCOPES[credential]
    const unavailableScope = operation.auth.scopes.find(scope => !availableScopes.includes(scope))
    if (unavailableScope)
      throw new TypeError(`${operation.id}: ${credential} does not grant the ${unavailableScope} scope`)
  }
  const ownershipCredentials = operation.auth.ownership.map(ownership => ownership.credential)
  if (ownershipCredentials.length !== operation.auth.credentials.length
    || new Set(ownershipCredentials).size !== ownershipCredentials.length
    || operation.auth.credentials.some(credential => !ownershipCredentials.includes(credential))) {
    throw new TypeError(`${operation.id}: every credential requires exactly one ownership rule`)
  }
  if (operation.errors.length === 0)
    throw new TypeError(`${operation.id}: declared stable errors are required`)
  if (!operation.errorResponse?.producer || !operation.errorResponse.client)
    throw new TypeError(`${operation.id}: an operation-specific error response schema is required`)
  if (Object.keys(operation.responses).length === 0)
    throw new TypeError(`${operation.id}: at least one response is required`)
  const pathParameters = new Set(pathParameterNames(operation.path))
  for (const reference of [...operation.resources.reads, ...operation.resources.changes]) {
    if (reference.idFrom.startsWith('params.') && !pathParameters.has(reference.idFrom.slice('params.'.length)))
      throw new TypeError(`${operation.id}: resource reference ${reference.idFrom} is not a declared path parameter`)
  }
  if (operation.docs.summary.length === 0 || operation.docs.description.length === 0 || operation.docs.tags.length === 0)
    throw new TypeError(`${operation.id}: public documentation metadata is incomplete`)
}

export function defineHttpOperation<const TOperation extends HttpV1OperationDefinition>(
  operation: TOperation,
): TOperation {
  assertOperation(operation)
  return operation
}

export function defineHttpSurface<
  const TOperations extends Readonly<Record<string, HttpV1OperationDefinition>>,
>(surface: HttpV1Surface<TOperations>): HttpV1Surface<TOperations> {
  if (surface.prefix !== `/api/${surface.name}/v1`)
    throw new TypeError(`${surface.name}: prefix must retain the surface and v1 major`)
  if (surface.version !== '1.0')
    throw new TypeError(`${surface.name}: wire version must be 1.0`)

  const ids = new Set<string>()
  const routes = new Set<string>()
  for (const [key, operation] of Object.entries(surface.operations)) {
    assertOperation(operation)
    if (!operation.id.startsWith(`${surface.name}.`))
      throw new TypeError(`${surface.name}: operation ID ${operation.id} must use the surface namespace`)
    if (ids.has(operation.id))
      throw new TypeError(`${surface.name}: duplicate operation ID ${operation.id}`)
    ids.add(operation.id)
    const route = `${operation.method} ${operation.path}`
    if (routes.has(route))
      throw new TypeError(`${surface.name}: duplicate method/path ${route}`)
    routes.add(route)
    if (key.length === 0)
      throw new TypeError(`${surface.name}: operation registry keys cannot be empty`)
  }
  return surface
}

export function listHttpOperations<const TProtocol extends HttpV1ProtocolLike>(
  protocol: TProtocol,
): HttpV1OperationEntry<TProtocol>[] {
  const entries: Array<{
    surface: HttpV1Surface
    operation: HttpV1OperationDefinition
  }> = []
  for (const surface of Object.values(protocol.surfaces)) {
    for (const operation of Object.values(surface.operations))
      entries.push({ surface, operation })
  }
  return entries as HttpV1OperationEntry<TProtocol>[]
}

export function defineResponseObject<
  const TProducerShape extends ZodRawShape,
  const TClientShape extends ZodRawShape = TProducerShape,
>(
  producerShape: TProducerShape,
  clientShape?: TClientShape,
): CompatibleResponseSchema<z.ZodObject<TProducerShape>, z.ZodObject<TClientShape>> {
  return {
    producer: z.strictObject(producerShape),
    client: z.looseObject(clientShape ?? producerShape as unknown as TClientShape),
  }
}

export function defineSuccessResponse<
  const TDataProducer extends ZodTypeAny,
  const TDataClient extends ZodTypeAny,
  const TMetaProducer extends ZodTypeAny,
  const TMetaClient extends ZodTypeAny,
>(
  data: CompatibleResponseSchema<TDataProducer, TDataClient>,
  meta: CompatibleResponseSchema<TMetaProducer, TMetaClient>,
): CompatibleResponseSchema<
  z.ZodObject<{ data: TDataProducer, meta: TMetaProducer }>,
  z.ZodObject<{ data: TDataClient, meta: TMetaClient }>
> {
  return defineResponseObject(
    { data: data.producer, meta: meta.producer },
    { data: data.client, meta: meta.client },
  )
}

export function buildHttpOperationPath(
  surface: HttpV1Surface,
  operation: HttpV1OperationDefinition,
  params?: unknown,
): string {
  if (!operation.id.startsWith(`${surface.name}.`))
    throw new TypeError(`${operation.id}: operation does not belong to the ${surface.name} surface`)
  const names = pathParameterNames(operation.path)
  if (names.length === 0) {
    if (params !== undefined && params !== null && (typeof params !== 'object' || Object.keys(params).length > 0))
      throw new TypeError(`${operation.id}: this operation has no path parameters`)
    return `${surface.prefix}${operation.path}`
  }

  if (operation.request.params === null)
    throw new TypeError(`${operation.id}: operation has an invalid path contract`)
  const parsed = operation.request.params.parse(params) as Record<string, unknown>
  const relativePath = operation.path.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = parsed[name]
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new TypeError(`${operation.id}: path parameter ${name} must serialize as a string or number`)
    const serialized = String(value)
    if (serialized.length === 0 || serialized === '.' || serialized === '..')
      throw new TypeError(`${operation.id}: path parameter ${name} cannot serialize as an empty or dot segment`)
    return encodeURIComponent(serialized)
  })
  return `${surface.prefix}${relativePath}`
}

export function resolveHttpOperation<
  const TEntries extends readonly HttpV1OperationEntry[],
>(
  entries: TEntries,
  request: HttpV1OperationRequest,
): ResolvedHttpV1Operation<TEntries[number]> | null {
  for (const entry of entries) {
    const { operation, surface } = entry
    if (operation.method !== request.method || surface.name !== request.surface)
      continue
    const params = matchHttpOperationPathParameters(operation, request.path)
    if (!params)
      continue
    const fullPath = buildHttpOperationPath(surface, operation, params)
    return {
      ...entry,
      params,
      path: fullPath.slice(surface.prefix.length + 1),
    } as ResolvedHttpV1Operation<TEntries[number]>
  }
  return null
}

export function createHttpV1Registry<const TProtocol extends HttpV1ProtocolLike>(
  protocol: TProtocol,
): HttpV1Registry<TProtocol> {
  interface RuntimeEntry { surface: HttpV1Surface, operation: HttpV1OperationDefinition }
  const entries = listHttpOperations(protocol) as RuntimeEntry[]
  const entriesById = new Map<string, RuntimeEntry>()
  for (const entry of entries) {
    if (entriesById.has(entry.operation.id))
      throw new TypeError(`Duplicate HTTP v1 operation ID: ${entry.operation.id}`)
    entriesById.set(entry.operation.id, entry)
  }

  function operation(id: string): RuntimeEntry {
    const entry = entriesById.get(id)
    if (!entry)
      throw new TypeError(`Unknown HTTP v1 operation ID: ${id}`)
    return entry
  }

  return {
    operation: id => operation(id) as HttpV1RegistryOperationEntry<TProtocol, typeof id>,
    resolve: (request, options) => {
      const allowed = options.allow.map(id => operation(id))
      return resolveHttpOperation(allowed, request) as ResolvedHttpV1Operation<
        HttpV1RegistryOperationEntry<TProtocol, typeof options.allow[number]>
      > | null
    },
    path: (id, params, options) => {
      const entry = operation(id)
      const path = buildHttpOperationPath(entry.surface, entry.operation, params)
      if (options?.apiRoot === undefined)
        return path
      return `${options.apiRoot.replace(/\/+$/, '')}${path.slice('/api'.length)}`
    },
  }
}
