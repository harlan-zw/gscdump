import type { ZodTypeAny } from 'zod'
import type { HttpV1OperationDefinition, HttpV1Surface } from './http-core'
import { z } from 'zod'
import { createGscdumpV1Protocol } from './operations'

export type ContractDocument = Record<string, unknown>

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function orderedJson(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(orderedJson)
  if (value === null || typeof value !== 'object')
    return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => [key, orderedJson(item)]),
  )
}

export function serializeContractDocument(document: ContractDocument): string {
  return `${JSON.stringify(orderedJson(document), null, 2)}\n`
}

function jsonSchema(schema: ZodTypeAny): ContractDocument {
  const document = z.toJSONSchema(schema) as ContractDocument
  const { $schema: _schema, ...body } = document
  return orderedJson(body) as ContractDocument
}

function rewriteDefinitionRefs(value: unknown, references: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value))
    return value.map(item => rewriteDefinitionRefs(item, references))
  if (value === null || typeof value !== 'object')
    return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (key === '$ref' && typeof item === 'string' && item.startsWith('#/$defs/')) {
      const name = item.slice('#/$defs/'.length)
      const reference = references[name]
      if (!reference)
        throw new TypeError(`JSON Schema references an unknown definition: ${name}`)
      return [key, reference]
    }
    return [key, rewriteDefinitionRefs(item, references)]
  }))
}

function registerComponentSchema(
  schema: ZodTypeAny,
  prefix: string,
  components: Record<string, ContractDocument>,
): ContractDocument {
  const document = jsonSchema(schema)
  const { $defs, ...body } = document
  if (!$defs)
    return body

  const definitions = $defs as Record<string, ContractDocument>
  const safePrefix = prefix.replace(/[^\w.-]/g, '_')
  const references = Object.fromEntries(Object.keys(definitions).map((name) => {
    return [name, `#/components/schemas/${safePrefix}.${name}`]
  }))
  for (const [name, definition] of Object.entries(definitions)) {
    const componentName = `${safePrefix}.${name}`
    if (componentName in components)
      throw new TypeError(`Duplicate generated component schema: ${componentName}`)
    components[componentName] = rewriteDefinitionRefs(definition, references) as ContractDocument
  }
  return rewriteDefinitionRefs(body, references) as ContractDocument
}

function objectSchemaProperties(schema: ZodTypeAny): {
  properties: Record<string, ContractDocument>
  required: Set<string>
} {
  const document = jsonSchema(schema)
  return {
    properties: document.properties as Record<string, ContractDocument> ?? {},
    required: new Set(document.required as string[] ?? []),
  }
}

function requestParameters(operation: HttpV1OperationDefinition): ContractDocument[] {
  const parameters: ContractDocument[] = []
  if (operation.request.params) {
    const { properties } = objectSchemaProperties(operation.request.params)
    for (const name of operation.path.matchAll(/\{([^{}]+)\}/g)) {
      parameters.push({
        name: name[1],
        in: 'path',
        required: true,
        schema: properties[name[1]!] ?? {},
      })
    }
  }
  for (const location of ['query', 'headers'] as const) {
    const schema = operation.request[location]
    if (!schema)
      continue
    const { properties, required } = objectSchemaProperties(schema)
    for (const [name, property] of Object.entries(properties)) {
      parameters.push({
        name,
        in: location === 'headers' ? 'header' : 'query',
        required: required.has(name),
        schema: property,
      })
    }
  }
  return parameters
}

function operationDocument(
  operation: HttpV1OperationDefinition,
  components: Record<string, ContractDocument>,
): ContractDocument {
  const errorComponentName = `${operation.id}.error`
  if (errorComponentName in components)
    throw new TypeError(`Duplicate generated component schema: ${errorComponentName}`)
  components[errorComponentName] = registerComponentSchema(
    operation.errorResponse.producer,
    errorComponentName,
    components,
  )
  const errorSchema = { $ref: `#/components/schemas/${errorComponentName}` }
  const responses = Object.fromEntries(
    Object.entries(operation.responses)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([status, response]) => [status, {
        description: status.startsWith('2') ? 'Successful response' : 'Documented response',
        content: {
          'application/json': {
            schema: registerComponentSchema(response.producer, `${operation.id}.response.${status}`, components),
          },
        },
      }]),
  )
  responses.default = {
    description: 'Stable error envelope',
    content: {
      'application/json': {
        schema: errorSchema,
      },
    },
  }
  responses['4XX'] = {
    description: 'Declared client error',
    content: {
      'application/json': {
        schema: errorSchema,
      },
    },
  }
  responses['5XX'] = {
    description: 'Safe internal or contract error',
    content: {
      'application/json': {
        schema: errorSchema,
      },
    },
  }

  const document: ContractDocument = {
    'operationId': operation.id,
    'summary': operation.docs.summary,
    'description': operation.docs.description,
    'tags': operation.docs.tags,
    'security': operation.auth.credentials.map(credential => ({ [credential]: [] })),
    'parameters': requestParameters(operation),
    responses,
    'x-gscdump-errors': operation.errors,
    'x-gscdump-examples': operation.docs.examples,
    'x-gscdump-lifecycle': operation.lifecycle,
    'x-gscdump-resources': operation.resources,
    'x-gscdump-scopes': operation.auth.scopes,
    'x-gscdump-ownership': operation.auth.ownership,
    'x-gscdump-semantics': operation.semantics,
    'x-gscdump-visibility': operation.visibility,
  }
  if (operation.request.body) {
    document.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: registerComponentSchema(operation.request.body, `${operation.id}.request.body`, components),
        },
      },
    }
  }
  return document
}

function openApiDocument(surface: HttpV1Surface): ContractDocument {
  const paths: Record<string, ContractDocument> = {}
  const schemas: Record<string, ContractDocument> = {}
  for (const operation of Object.values(surface.operations).sort((left, right) => {
    return compareStrings(`${left.path}\0${left.method}\0${left.id}`, `${right.path}\0${right.method}\0${right.id}`)
  })) {
    const path = `${surface.prefix}${operation.path}`
    paths[path] ??= {}
    paths[path]![operation.method.toLowerCase()] = operationDocument(operation, schemas)
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: `gscdump ${surface.name} API`,
      version: surface.version,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: 'https://gscdump.com' }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        user_key: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'gscdump user key',
        },
        partner_key: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'gscdump partner key',
        },
      },
    },
  }
}

function asyncApiDocument(protocol: ReturnType<typeof createGscdumpV1Protocol>): ContractDocument {
  const schemas: Record<string, ContractDocument> = {}
  const clientFrameSchema = registerComponentSchema(protocol.schemas.clientFrame, 'clientFrame', schemas)
  const serverFrameSchema = registerComponentSchema(protocol.schemas.serverFrame, 'serverFrame', schemas)
  return {
    'asyncapi': '3.1.0',
    'info': {
      title: 'gscdump realtime API',
      version: '1.0',
    },
    'servers': {
      production: {
        'host': 'gscdump.com',
        'pathname': '/ws/v1',
        'protocol': 'wss',
        'x-websocket-subprotocol': protocol.constants.realtimeSubprotocol,
      },
    },
    'channels': {
      notifications: {
        address: '/',
        messages: {
          clientFrame: { $ref: '#/components/messages/clientFrame' },
          serverFrame: { $ref: '#/components/messages/serverFrame' },
        },
      },
    },
    'operations': {
      receiveServerFrame: {
        action: 'receive',
        channel: { $ref: '#/channels/notifications' },
        messages: [{ $ref: '#/channels/notifications/messages/serverFrame' }],
      },
      sendClientFrame: {
        action: 'send',
        channel: { $ref: '#/channels/notifications' },
        messages: [{ $ref: '#/channels/notifications/messages/clientFrame' }],
      },
    },
    'components': {
      messages: {
        clientFrame: {
          name: 'clientFrame',
          contentType: 'application/json',
          payload: clientFrameSchema,
        },
        serverFrame: {
          name: 'serverFrame',
          contentType: 'application/json',
          payload: serverFrameSchema,
        },
      },
      schemas,
    },
    'x-heartbeat-text-frames': {
      ping: protocol.constants.ping,
      pong: protocol.constants.pong,
    },
    'x-gscdump-event-semantics': protocol.constants.eventSemantics,
  }
}

export function createGscdumpV1Documents(): Record<
  | 'openapi.partner.v1.json'
  | 'openapi.analytics.v1.json'
  | 'openapi.realtime.v1.json'
  | 'asyncapi.realtime.v1.json',
  ContractDocument
> {
  const protocol = createGscdumpV1Protocol()
  return {
    'openapi.partner.v1.json': openApiDocument(protocol.surfaces.partner),
    'openapi.analytics.v1.json': openApiDocument(protocol.surfaces.analytics),
    'openapi.realtime.v1.json': openApiDocument(protocol.surfaces.realtime),
    'asyncapi.realtime.v1.json': asyncApiDocument(protocol),
  }
}
