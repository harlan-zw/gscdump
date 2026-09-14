import type {
  AnalyticsRowsV1Request,
  AnalyticsRowsV1Response,
  RealtimeV1Cursor,
} from '@gscdump/contracts/v1'
import { readFile } from 'node:fs/promises'
import {
  buildHttpOperationPath,
  createGscdumpV1Documents,
  createGscdumpV1Protocol,
  defineHttpOperation,
  defineHttpSurface,
  GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS,
  GSCDUMP_REALTIME_PROTOCOL_VERSION,
  HTTP_V1_CREDENTIAL_SCOPES,
  listHttpOperations,
  REALTIME_V1_EVENT_SEMANTICS,
  resolveHttpOperation,
  serializeContractDocument,
} from '@gscdump/contracts/v1'
import { createGscdumpV1BrowserSchemas } from '@gscdump/contracts/v1/browser'
import { createRealtimeV1Schemas } from '@gscdump/contracts/v1/realtime'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'

const occurredAt = '2026-07-14T08:00:00.000Z'

function durableEvent() {
  return {
    type: 'event',
    protocolVersion: GSCDUMP_REALTIME_PROTOCOL_VERSION,
    eventVersion: 1,
    id: 'evt_01',
    name: 'site.analytics.ready',
    cursor: { streamId: 'user:u_01', sequence: '142' },
    subject: { type: 'site', id: 's_01' },
    changes: [
      { type: 'site.analytics', id: 's_01', kind: 'updated' },
      { type: 'site.lifecycle', id: 's_01', kind: 'updated' },
    ],
    occurredAt,
    correlationId: 'req_01',
    delivery: 'durable',
    data: {},
  } as const
}

function findContractObject(
  value: unknown,
  predicate: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findContractObject(item, predicate)
      if (match)
        return match
    }
    return undefined
  }
  if (value === null || typeof value !== 'object')
    return undefined
  const candidate = value as Record<string, unknown>
  if (predicate(candidate))
    return candidate
  for (const item of Object.values(candidate)) {
    const match = findContractObject(item, predicate)
    if (match)
      return match
  }
  return undefined
}

describe('@gscdump/contracts/v1 HTTP registry', () => {
  it('exposes the representative v1 operations with explicit primary consistency', () => {
    const protocol = createGscdumpV1Protocol()

    expect(protocol.surfaces.partner.operations.getUserLifecycle).toMatchObject({
      id: 'partner.users.lifecycle.get',
      method: 'GET',
      path: '/users/{userId}/lifecycle',
      semantics: { kind: 'query', readConsistency: 'primary' },
      auth: {
        ownership: [
          { credential: 'user_key', rule: 'self' },
          { credential: 'partner_key', rule: 'linked_user' },
        ],
      },
    })
    expect(protocol.surfaces.analytics.operations.queryRows).toMatchObject({
      id: 'analytics.rows.query',
      method: 'POST',
      semantics: { kind: 'query', idempotent: true, readConsistency: 'primary' },
    })
    expect(protocol.surfaces.realtime.operations.getStreamHead.path).toBe('/stream/head')
    expect(protocol.surfaces.realtime.operations.createTicket.path).toBe('/tickets')
    expect(protocol.surfaces.realtime.operations.createTicket.request.body).toBe(protocol.schemas.ticketRequest)
  })

  it('validates and percent-encodes path parameters through one builder', () => {
    const protocol = createGscdumpV1Protocol()
    const operation = protocol.surfaces.analytics.operations.queryRows
    const freeformPathOperation = defineHttpOperation({
      ...operation,
      id: 'analytics.rows.locator',
      path: '/locators/{locator}/rows',
      request: {
        ...operation.request,
        params: z.strictObject({ locator: z.string() }),
      },
      resources: { reads: [], changes: [] },
    })

    expect(buildHttpOperationPath(protocol.surfaces.analytics, freeformPathOperation, {
      locator: 'example.com/a:b',
    })).toBe('/api/analytics/v1/locators/example.com%2Fa%3Ab/rows')
    expect(() => buildHttpOperationPath(protocol.surfaces.analytics, freeformPathOperation, {
      locator: '..',
    })).toThrow(/dot segment/)
    expect(() => buildHttpOperationPath(protocol.surfaces.analytics, operation, {
      siteId: 's_01',
      unexpected: true,
    })).toThrow()
    expect(() => buildHttpOperationPath(
      protocol.surfaces.realtime,
      protocol.surfaces.realtime.operations.getStreamHead,
      { streamId: 'user:u_01' },
    )).toThrow(/no path parameters/)
    expect(() => buildHttpOperationPath(
      protocol.surfaces.partner,
      protocol.surfaces.analytics.operations.queryRows,
      { siteId: 's_01' },
    )).toThrow(/does not belong to the partner surface/)

    expect(() => defineHttpOperation({
      ...operation,
      id: 'analytics.rows.unsafe.path',
      path: '/rows/../future',
    })).toThrow(/safe literal surface-relative template/)
    expect(() => defineHttpOperation({
      ...operation,
      id: 'analytics.rows.malformed.path',
      path: '/rows/{siteId',
    })).toThrow(/safe literal surface-relative template/)
  })

  it('accepts the team id partner.teams.create actually returns on every {teamId} path param', () => {
    const protocol = createGscdumpV1Protocol()

    // `teams` carries BOTH `id` (raw uuid, primary key) and `public_id` (`t_…`).
    // The partner HTTP handlers resolve `eq(teams.id, teamId)` and
    // `partner.teams.create` hands back that raw uuid, so a param schema that
    // only admits the `t_` form makes every one of these operations
    // unreachable through the SDK — it rejects client-side, before any request.
    // Both forms must parse until the surface is migrated onto public ids.
    const rawUuid = '700195cb-5dc8-4b3f-9bac-9ab8258da792'
    const publicId = 't_01H9Z3'
    const teamPathOperations = [
      protocol.surfaces.partner.operations.renameTeam,
      protocol.surfaces.partner.operations.deleteTeam,
      protocol.surfaces.partner.operations.listTeamMembers,
      protocol.surfaces.partner.operations.addTeamMember,
      protocol.surfaces.partner.operations.getTeamCatalog,
      protocol.surfaces.partner.operations.bindTeamCatalog,
    ]

    for (const operation of teamPathOperations) {
      expect(
        operation.request.params?.safeParse({ teamId: rawUuid }).success,
        `${operation.id} must accept the uuid partner.teams.create returns`,
      ).toBe(true)
      expect(
        operation.request.params?.safeParse({ teamId: publicId }).success,
        `${operation.id} must still accept the public team id`,
      ).toBe(true)
      expect(
        operation.request.params?.safeParse({ teamId: 'not a team id' }).success,
        `${operation.id} must still reject a malformed team id`,
      ).toBe(false)
    }
  })

  it('lists and resolves exact registry operations through one fail-closed matcher', () => {
    const protocol = createGscdumpV1Protocol()
    const entries = listHttpOperations(protocol)

    expect(entries.map(entry => entry.operation.id)).toContain('partner.users.lifecycle.get')
    expect(entries.map(entry => entry.operation.id)).toContain('partner.sites.sitemaps.urls.get')
    expect(entries.map(entry => entry.operation.id)).toContain('partner.sites.sitemaps.export.get')
    // Retired by the 2026-08-04 action-lane boundary decision, after the
    // zero-use census cleared on 2026-08-11. Both capabilities are
    // consumer-side now, so the protocol must not offer them.
    expect(entries.map(entry => entry.operation.id)).not.toContain('partner.sites.cross.source.query')
    expect(entries.map(entry => entry.operation.id)).not.toContain('partner.keywords.enrich.query')
    expect(resolveHttpOperation(entries, {
      method: 'GET',
      surface: 'partner',
      path: 'users/u_01/lifecycle',
    })).toMatchObject({
      operation: { id: 'partner.users.lifecycle.get' },
      params: { userId: 'u_01' },
      path: 'users/u_01/lifecycle',
      surface: { name: 'partner' },
    })
    expect(resolveHttpOperation(entries, {
      method: 'GET',
      surface: 'partner',
      path: 'sites/s_01/indexing',
    })).toMatchObject({
      operation: { id: 'partner.sites.indexing.get' },
      params: { siteId: 's_01' },
    })
    expect(resolveHttpOperation(entries, {
      method: 'POST',
      surface: 'analytics',
      path: 'sites/s_01/rows',
    })?.path).toBe('sites/s_01/rows')

    expect(resolveHttpOperation(entries, {
      method: 'GET',
      surface: 'analytics',
      path: 'sites/s_01/rows',
    })).toBeNull()
    expect(resolveHttpOperation(entries, {
      method: 'GET',
      surface: 'partner',
      path: 'sites/%2e%2e/indexing',
    })).toBeNull()
    expect(resolveHttpOperation(entries, {
      method: 'GET',
      surface: 'partner',
      path: 'sites/s_01%2Findexing',
    })).toBeNull()
    expect(resolveHttpOperation(entries, {
      method: 'GET',
      surface: 'partner',
      path: 'sites/s_01/indexing/extra',
    })).toBeNull()
  })

  it('rejects duplicate registry IDs, route collisions, and unsafe user-key consistency', () => {
    const protocol = createGscdumpV1Protocol()
    const operation = protocol.surfaces.analytics.operations.queryRows

    expect(() => defineHttpSurface({
      name: 'analytics',
      prefix: '/api/analytics/v1',
      version: '1.0',
      operations: { first: operation, second: operation },
    })).toThrow(/duplicate operation ID/)

    expect(() => defineHttpSurface({
      name: 'analytics',
      prefix: '/api/analytics/v1',
      version: '1.0',
      operations: {
        first: operation,
        second: { ...operation, id: 'analytics.rows.copy' },
      },
    })).toThrow(/duplicate method\/path/)

    expect(() => defineHttpOperation({
      ...operation,
      id: 'analytics.rows.unsafe',
      semantics: { ...operation.semantics, readConsistency: null },
    })).toThrow(/must declare read consistency/)

    expect(defineHttpOperation({
      ...operation,
      id: 'analytics.rows.replica',
      semantics: { ...operation.semantics, readConsistency: 'replica-ok' },
      auth: {
        credentials: ['partner_key'],
        scopes: operation.auth.scopes,
        ownership: [{ credential: 'partner_key', rule: 'authorized_site' }],
      },
    }).semantics.readConsistency).toBe('replica-ok')

    expect(() => defineHttpOperation({
      ...operation,
      id: 'analytics.rows.user.replica',
      semantics: { ...operation.semantics, readConsistency: 'replica-ok' },
    })).toThrow(/user_key queries must use primary consistency/)

    expect(() => defineHttpOperation({
      ...operation,
      id: 'analytics.rows.unowned',
      auth: { ...operation.auth, ownership: [] },
    })).toThrow(/exactly one ownership rule/)

    expect(() => defineHttpOperation({
      ...operation,
      id: 'analytics.rows.badresource',
      resources: {
        reads: [{ type: 'site.analytics', idFrom: 'params.missing' }],
        changes: [],
      },
    })).toThrow(/not a declared path parameter/)

    expect(() => defineHttpSurface({
      name: 'analytics',
      prefix: '/api/analytics/v1',
      version: '1.0',
      operations: { first: { ...operation, id: 'partner.rows.query' } },
    })).toThrow(/surface namespace/)

    expect(() => defineHttpOperation({
      ...operation,
      id: 'analytics.rows.team.scope',
      auth: {
        credentials: ['user_key'],
        scopes: ['teams:read'],
        ownership: [{ credential: 'user_key', rule: 'authorized_site' }],
      },
    })).toThrow(/does not grant the teams:read scope/)
    expect(HTTP_V1_CREDENTIAL_SCOPES.partner_key).toContain('teams:read')
    expect(HTTP_V1_CREDENTIAL_SCOPES.user_key).not.toContain('teams:read')
  })

  it('keeps request objects strict, including tickets with no stream selector', () => {
    const { schemas } = createGscdumpV1Protocol()

    expect(schemas.analyticsRowsRequest.parse({
      dimensions: ['query'],
      metrics: ['clicks'],
      rowLimit: 100,
    })).toMatchObject({ dimensions: ['query'] })
    expect(schemas.analyticsRowsRequest.safeParse({
      dimensions: ['query'],
      arbitrary: true,
    }).success).toBe(false)
    expect(schemas.analyticsReportRequest.parse({
      state: { dimensions: ['query'], searchType: 'web' },
      filter: 'new',
    })).toMatchObject({ state: { dimensions: ['query'] }, filter: 'new' })
    expect(schemas.analyticsReportRequest.safeParse({
      state: { dimensions: ['query'] },
      arbitrary: true,
    }).success).toBe(false)
    expect(schemas.analyticsReportDetailRequest.safeParse({
      state: { dimensions: ['date'] },
      filter: 'new',
    }).success).toBe(false)
    expect(schemas.analyticsReportRequest.safeParse({ state: { dimensions: ['date'] } }).success).toBe(false)
    expect(schemas.analyticsReportDetailRequest.safeParse({ state: { dimensions: ['query'] } }).success).toBe(false)
    expect(schemas.ticketRequest.parse({})).toEqual({})
    expect(schemas.ticketRequest.parse({ origin: 'https://nuxtseo.com' })).toEqual({
      origin: 'https://nuxtseo.com',
    })
    expect(schemas.ticketRequest.safeParse({ origin: 'https://nuxtseo.com/path' }).success).toBe(false)
    expect(schemas.ticketRequest.safeParse({ streamId: 'user:u_01' }).success).toBe(false)
  })

  it('exposes browser-safe keyword enrichment schemas from the public operation contract', () => {
    const browserSchemas = createGscdumpV1BrowserSchemas()

    expect(browserSchemas.keywordEnrichmentRequest.parse({
      keywords: ['nuxt seo'],
    })).toEqual({ keywords: ['nuxt seo'] })
    expect(browserSchemas.keywordEnrichmentRequest.safeParse({
      keywords: [],
    }).success).toBe(false)
    expect(browserSchemas.keywordEnrichmentRequest.safeParse({
      keywords: ['nuxt seo'],
      arbitrary: true,
    }).success).toBe(false)
    expect(browserSchemas.keywordEnrichmentResponse.client.parse({
      data: {
        metrics: {
          'nuxt seo': {
            difficulty: 12,
            searchVolume: 100,
            cpc: null,
            futureMetric: true,
          },
        },
        futureData: true,
      },
      meta: {
        requestId: 'req_01',
        surface: 'partner',
        version: '1.0',
        futureMeta: true,
      },
      futureEnvelope: true,
    }).data.metrics['nuxt seo']).toMatchObject({
      difficulty: 12,
      searchVolume: 100,
      cpc: null,
      futureMetric: true,
    })
  })

  it('models indexing transitions as bounded observations instead of point timestamps', () => {
    const operation = createGscdumpV1Protocol().surfaces.partner.operations.listSiteIndexingTransitions

    expect(operation).toMatchObject({
      id: 'partner.sites.indexing.transitions.list',
      method: 'GET',
      path: '/sites/{siteId}/indexing/transitions',
    })
    expect(operation.request.query!.parse({
      startDate: '2026-06-01',
      endDate: '2026-07-26',
      field: 'coverageState',
      fromValue: 'Submitted and indexed',
      toValue: 'Crawled - currently not indexed',
      limit: '100',
      offset: '0',
    })).toMatchObject({
      field: 'coverageState',
      limit: '100',
    })

    const response = operation.docs.examples.response as Record<string, unknown>
    expect(operation.responses[200]!.producer.parse(response)).toEqual(response)
    expect(operation.responses[200]!.producer.safeParse({
      ...response,
      data: {
        ...(response.data as object),
        observationWindow: {
          _tag: 'empty',
          gapDaysMedian: 2,
          gapDaysP90: null,
          sampleSize: 0,
        },
      },
    }).success).toBe(false)
    expect(JSON.stringify(response)).not.toContain('changedAt')
  })

  it('validates the normalized recursive analytics filter grammar without an unknown escape hatch', () => {
    const { analyticsRowsRequest } = createGscdumpV1Protocol().schemas
    const request = {
      dimensions: ['query'],
      dataState: 'all',
      aggregationType: 'auto',
      filter: {
        _filters: [{ dimension: 'date', operator: 'between', expression: '2026-07-01', expression2: '2026-07-14' }],
        _nestedGroups: [{
          _filters: [{ dimension: 'query', operator: 'contains', expression: 'nuxt' }],
          _groupType: 'or',
        }],
        _groupType: 'and',
      },
      prefilter: {
        _filters: [{ dimension: 'impressions', operator: 'metricGte', expression: '10' }],
      },
    }

    expect(analyticsRowsRequest.parse(request)).toEqual(request)
    expect(analyticsRowsRequest.safeParse({
      ...request,
      filter: { ...request.filter, arbitrary: true },
    }).success).toBe(false)
    expect(analyticsRowsRequest.safeParse({
      dimensions: ['query'],
      filter: { _filters: [{ dimension: 'date', operator: 'between', expression: '2026-07-01' }] },
    }).success).toBe(false)
    expect(analyticsRowsRequest.safeParse({
      dimensions: ['query'],
      filter: { _filters: [], _nestedGroups: [] },
    }).success).toBe(false)
  })

  it('fails current producer responses closed while clients tolerate additive object fields', () => {
    const protocol = createGscdumpV1Protocol()
    const operation = protocol.surfaces.analytics.operations.queryRows
    const response = operation.docs.examples.response as Record<string, unknown>

    expect(operation.responses[200]!.producer.parse(response)).toEqual(response)
    const additive = {
      ...response,
      futureEnvelopeField: true,
      data: { ...(response.data as object), futureDataField: true },
      meta: { ...(response.meta as object), futureMetaField: true },
    }
    expect(operation.responses[200]!.producer.safeParse(additive).success).toBe(false)
    expect(operation.responses[200]!.client.parse(additive)).toMatchObject(additive)

    const futureClosedEnum = {
      ...response,
      meta: { ...(response.meta as object), sourceKind: 'future-source' },
    }
    expect(operation.responses[200]!.client.safeParse(futureClosedEnum).success).toBe(false)
  })

  it('applies additive compatibility recursively to lifecycle objects', () => {
    const protocol = createGscdumpV1Protocol()
    const response = protocol.surfaces.partner.operations.getUserLifecycle.docs.examples.response as {
      data: Record<string, unknown>
      meta: Record<string, unknown>
    }
    const account = response.data.account as Record<string, unknown>
    const additive = {
      ...response,
      data: {
        ...response.data,
        account: { ...account, futureAccountField: 'supported' },
      },
    }

    expect(protocol.schemas.lifecycleResponse.producer.safeParse(additive).success).toBe(false)
    expect(protocol.schemas.lifecycleResponse.client.parse(additive)).toMatchObject(additive)
  })

  it('applies additive compatibility recursively to realtime HTTP heads', () => {
    const protocol = createGscdumpV1Protocol()
    const headResponse = protocol.surfaces.realtime.operations.getStreamHead.docs.examples.response as {
      data: { head: Record<string, unknown> }
      meta: Record<string, unknown>
    }
    const additiveHead = {
      ...headResponse,
      data: { ...headResponse.data, head: { ...headResponse.data.head, futureHeadField: true } },
    }
    expect(protocol.schemas.streamHeadResponse.producer.safeParse(additiveHead).success).toBe(false)
    expect(protocol.schemas.streamHeadResponse.client.parse(additiveHead)).toMatchObject(additiveHead)

    const ticketResponse = protocol.surfaces.realtime.operations.createTicket.docs.examples.response as {
      data: { head: Record<string, unknown> }
      meta: Record<string, unknown>
    }
    const additiveTicket = {
      ...ticketResponse,
      data: { ...ticketResponse.data, head: { ...ticketResponse.data.head, futureHeadField: true } },
    }
    expect(protocol.schemas.ticketResponse.producer.safeParse(additiveTicket).success).toBe(false)
    expect(protocol.schemas.ticketResponse.client.parse(additiveTicket)).toMatchObject(additiveTicket)
    expect(createRealtimeV1Schemas().ticketResponseClient.parse(additiveTicket)).toMatchObject(additiveTicket)
  })

  it('uses one strict producer and additive client error envelope', () => {
    const { errorEnvelope } = createGscdumpV1Protocol().schemas
    const error = {
      error: {
        code: 'site_not_found',
        message: 'Site not found.',
        requestId: 'req_01',
        retryable: false,
        details: {},
      },
    }
    expect(errorEnvelope.producer.parse(error)).toEqual(error)
    const withoutDetails = {
      error: {
        code: 'site_not_found',
        message: 'Site not found.',
        requestId: 'req_01',
        retryable: false,
      },
    }
    expect(errorEnvelope.producer.safeParse(withoutDetails).success).toBe(false)
    expect(errorEnvelope.client.safeParse(withoutDetails).success).toBe(false)
    const additive = { ...error, futureEnvelopeField: true }
    expect(errorEnvelope.producer.safeParse(additive).success).toBe(false)
    expect(errorEnvelope.client.parse(additive)).toMatchObject(additive)
    expect(errorEnvelope.producer.safeParse({
      ...withoutDetails,
      error: { ...withoutDetails.error, details: { inspect: () => true } },
    }).success).toBe(false)

    const analyticsError = createGscdumpV1Protocol().surfaces.analytics.operations.queryRows.errorResponse
    expect(analyticsError.client.safeParse({
      error: { ...error.error, code: 'user_not_found' },
    }).success).toBe(false)
    expect(analyticsError.client.parse(error)).toMatchObject({ error: { code: 'site_not_found' } })
  })

  it('accepts only JSON wire values in dynamic producer payloads', () => {
    const protocol = createGscdumpV1Protocol()
    const response = protocol.surfaces.analytics.operations.queryRows.responses[200]!
    const example = protocol.surfaces.analytics.operations.queryRows.docs.examples.response as {
      data: { rows: unknown[] }
      meta: Record<string, unknown>
    }
    const scalarRowResponse = {
      ...example,
      data: {
        rows: [{ query: 'nuxt', clicks: 4, branded: false, prior: null }],
      },
    }

    expect(response.producer.parse(scalarRowResponse)).toEqual(scalarRowResponse)
    expect(response.producer.safeParse({
      ...example,
      data: { rows: [{ query: () => 'nuxt' }] },
    }).success).toBe(false)
    expect(response.producer.safeParse({
      ...example,
      data: { rows: [{ query: { nested: true } }] },
    }).success).toBe(false)
  })

  it('derives public DTO types from runtime schemas', () => {
    expectTypeOf<AnalyticsRowsV1Request>().toMatchTypeOf<{
      dimensions: Array<'page' | 'query' | 'queryCanonical' | 'country' | 'device' | 'date' | 'searchAppearance' | 'hour'>
    }>()
    expectTypeOf<AnalyticsRowsV1Response>().toHaveProperty('data')
    expectTypeOf<RealtimeV1Cursor>().toMatchTypeOf<{
      streamId: string
      sequence: string
    }>()
  })
})

describe('@gscdump/contracts/v1 realtime protocol', () => {
  it('parses a durable semantic event with multiple base changes', () => {
    const schemas = createGscdumpV1Protocol().schemas
    const event = durableEvent()

    expect(schemas.event.parse(event)).toEqual(event)
    expect(schemas.serverFrame.parse(event)).toEqual(event)
    expect(schemas.event.safeParse({
      ...event,
      cursor: { ...event.cursor, sequence: 142 },
    }).success).toBe(false)
    expect(schemas.event.safeParse({ ...event, changes: [] }).success).toBe(false)
    expect(schemas.event.safeParse({
      ...event,
      changes: [{ type: 'site.analytics', id: 's_01', kind: 'updated' }],
    }).success).toBe(false)
    expect(REALTIME_V1_EVENT_SEMANTICS['site.analytics.ready']).toEqual({
      delivery: 'durable',
      baseChanges: ['site.analytics', 'site.lifecycle'],
    })
  })

  it('keeps unknown event/resource names compatible while identifying known resources', () => {
    const schemas = createGscdumpV1Protocol().schemas
    const event = {
      ...durableEvent(),
      name: 'site.future.changed',
      changes: [{ type: 'future.widget', id: 'x_01', kind: 'updated' }],
    }

    expect(schemas.event.parse(event)).toMatchObject({ name: 'site.future.changed' })
    expect(schemas.resourceChange.safeParse({
      type: 'site.analytics',
      id: 'x_01',
      kind: 'updated',
    }).success).toBe(false)
    expect(schemas.knownResourceType.safeParse('site.analytics').success).toBe(true)
    expect(schemas.knownResourceType.safeParse('site.future').success).toBe(false)
  })

  it('uses a URL-safe opaque alphabet for public IDs and JSON event data', () => {
    const schemas = createGscdumpV1Protocol().schemas

    expect(schemas.publicSiteId.safeParse('s_example.com/a:b').success).toBe(false)
    expect(schemas.publicSiteId.safeParse('s_example_01-A').success).toBe(true)
    expect(schemas.event.safeParse({
      ...durableEvent(),
      data: { nested: { invalid: () => true } },
    }).success).toBe(false)
    expect(schemas.event.safeParse({
      ...durableEvent(),
      data: { invalid: 1n },
    }).success).toBe(false)
    expect(schemas.event.safeParse({
      ...durableEvent(),
      data: { invalid: new Date(occurredAt) },
    }).success).toBe(false)
    expect(schemas.event.safeParse({
      ...durableEvent(),
      data: { nested: ['wire', 1, true, null] },
    }).success).toBe(true)
  })

  it('requires null cursors and no resource changes for ephemeral progress', () => {
    const schemas = createGscdumpV1Protocol().schemas
    const progress = {
      ...durableEvent(),
      name: 'site.lifecycle.progress',
      cursor: null,
      changes: [],
      delivery: 'ephemeral',
      data: { completed: 3, total: 10 },
    }

    expect(schemas.event.parse(progress)).toEqual(progress)
    expect(schemas.event.safeParse({
      ...progress,
      changes: [{ type: 'site.lifecycle', id: 's_01', kind: 'updated' }],
    }).success).toBe(false)
    expect(schemas.event.safeParse({ ...progress, name: 'site.analytics.ready' }).success).toBe(false)
    expect(schemas.event.safeParse({
      ...durableEvent(),
      name: 'site.lifecycle.progress',
      changes: [{ type: 'site.lifecycle', id: 's_01', kind: 'updated' }],
    }).success).toBe(false)
  })

  it('validates hello, ack, batch, resync, and error frame transcripts', () => {
    const schemas = createGscdumpV1Protocol().schemas
    const cursor = { streamId: 'user:u_01', sequence: '142' }

    expect(schemas.clientFrame.parse({
      type: 'hello',
      protocolVersion: 1,
      sdkVersion: '1.0.0',
      resume: cursor,
    })).toMatchObject({ type: 'hello', resume: cursor })
    expect(schemas.clientFrame.parse({ type: 'ack', cursor })).toMatchObject({ type: 'ack' })
    expect(schemas.serverFrame.parse({ type: 'batch', events: [durableEvent()] })).toMatchObject({
      type: 'batch',
    })
    expect(schemas.serverFrame.parse({
      type: 'batch',
      events: [
        durableEvent(),
        { ...durableEvent(), id: 'evt_02', cursor: { ...cursor, sequence: '143' } },
      ],
    })).toMatchObject({ type: 'batch' })
    expect(schemas.serverFrame.safeParse({
      type: 'batch',
      events: [
        durableEvent(),
        { ...durableEvent(), id: 'evt_02', cursor: { ...cursor, sequence: '144' } },
      ],
    }).success).toBe(false)
    expect(schemas.serverFrame.safeParse({
      type: 'batch',
      events: [
        durableEvent(),
        { ...durableEvent(), id: 'evt_02', cursor: { streamId: 'partner:p_01', sequence: '143' } },
      ],
    }).success).toBe(false)
    expect(schemas.serverFrame.safeParse({
      type: 'batch',
      events: [{
        ...durableEvent(),
        name: 'site.lifecycle.progress',
        cursor: null,
        changes: [],
        delivery: 'ephemeral',
      }],
    }).success).toBe(false)
    expect(schemas.serverFrame.parse({
      type: 'resync.required',
      reason: 'retention_gap',
      scope: { type: 'stream', streamId: 'user:u_01' },
      resumeAfter: cursor,
    })).toMatchObject({ type: 'resync.required' })
    expect(schemas.serverFrame.safeParse({
      type: 'resync.required',
      reason: 'stream_mismatch',
      scope: { type: 'stream', streamId: 'partner:p_01' },
      resumeAfter: cursor,
    }).success).toBe(false)
    expect(schemas.serverFrame.parse({
      type: 'replay.begin',
      after: { ...cursor, sequence: '100' },
      through: cursor,
    })).toMatchObject({ type: 'replay.begin' })
    expect(schemas.serverFrame.safeParse({
      type: 'replay.begin',
      after: cursor,
      through: { ...cursor, sequence: '100' },
    }).success).toBe(false)
    expect(schemas.serverFrame.safeParse({
      type: 'replay.begin',
      after: cursor,
      through: { streamId: 'partner:p_01', sequence: '143' },
    }).success).toBe(false)
    expect(schemas.serverFrame.parse({
      type: 'ready',
      protocolVersion: 1,
      connectionId: 'conn_01',
      streamId: 'user:u_01',
      replayFloor: { streamId: 'user:u_01', sequence: '100' },
      head: cursor,
      limits: { maxBatchEvents: 20, maxUnackedEvents: 500 },
      heartbeat: { ping: 'ping', pong: 'pong' },
      expiresAt: '2026-07-14T08:15:00.000Z',
    })).toMatchObject({ type: 'ready', replayFloor: { sequence: '100' } })
    expect(schemas.serverFrame.parse({
      type: 'error',
      error: { code: 'overloaded', message: 'Try later.', retryable: true, retryAfter: 3 },
    })).toMatchObject({ type: 'error' })
  })

  it('keeps tickets exact, short-lived, and free from host cache state', () => {
    const protocol = createGscdumpV1Protocol()
    const claims = {
      v: 1,
      iss: 'https://gscdump.com',
      aud: 'https://gscdump.com/ws/v1',
      kid: 'key_01',
      jti: 'AAAAAAAAAAAAAAAAAAAAAA',
      iat: 1_000,
      exp: 1_060,
      connectionExpiresAt: 1_900,
      principalClass: 'user_key',
      principalPublicId: 'u_01',
      streamId: 'user:u_01',
      origin: 'https://nuxtseo.com',
    }

    expect(protocol.schemas.ticketClaims.parse(claims)).toEqual(claims)
    expect(protocol.constants.ticketTtlSeconds).toBe(60)
    expect(protocol.constants.maxConnectionSeconds).toBe(GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS)
    expect(JSON.stringify(claims)).not.toContain('cacheScope')
    expect(protocol.schemas.ticketClaims.safeParse({ ...claims, cacheScope: 'host-session' }).success).toBe(false)
    expect(protocol.schemas.ticketClaims.safeParse({ ...claims, exp: 1_061 }).success).toBe(false)
    expect(protocol.schemas.ticketClaims.safeParse({ ...claims, streamId: 'user:u_02' }).success).toBe(false)
  })
})

describe('@gscdump/contracts/v1 generated documents', () => {
  it('generates deterministic OpenAPI and AsyncAPI from the executable registries', async () => {
    const first = createGscdumpV1Documents()
    const second = createGscdumpV1Documents()
    expect(Object.keys(first).sort()).toEqual([
      'asyncapi.realtime.v1.json',
      'openapi.analytics.v1.json',
      'openapi.partner.v1.json',
      'openapi.realtime.v1.json',
    ])

    for (const [filename, document] of Object.entries(first)) {
      const serialized = serializeContractDocument(document)
      expect(serialized).toBe(serializeContractDocument(second[filename as keyof typeof second]))
      const committed = await readFile(new URL(`../generated/${filename}`, import.meta.url), 'utf8')
      expect(committed).toBe(serialized)
    }
  })

  it('states the epoch unit for the site tier expiry in the published operation', async () => {
    const committed = await readFile(new URL('../generated/openapi.partner.v1.json', import.meta.url), 'utf8')
    const document = JSON.parse(committed) as {
      paths: Record<string, { patch: { description: string } }>
    }
    const description = document.paths['/api/partner/v1/sites/{siteId}/tier']!.patch.description

    expect(description).toMatch(/epoch (seconds|milliseconds)/)
  })

  it('allows omitted Bing pagination while documenting numeric bounds and defaults', () => {
    const document = createGscdumpV1Documents()['openapi.partner.v1.json']
    const paths = document.paths as Record<string, { get: { parameters: Array<{ name: string, required: boolean, schema: Record<string, unknown> }> } }>
    const parameters = paths['/api/partner/v1/sites/{siteId}/bing/data']!.get.parameters

    expect(parameters.find(parameter => parameter.name === 'limit')).toMatchObject({
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    })
    expect(parameters.find(parameter => parameter.name === 'offset')).toMatchObject({
      required: false,
      schema: { type: 'integer', minimum: 0, maximum: 100_000, default: 0 },
    })
    for (const name of ['dataset', 'startDate', 'endDate'])
      expect(parameters.find(parameter => parameter.name === name)?.required).toBe(true)
  })

  it('publishes the literal v1 paths and protocol schemas', () => {
    const documents = createGscdumpV1Documents()
    const analytics = documents['openapi.analytics.v1.json']
    const realtime = documents['openapi.realtime.v1.json']
    const asyncapi = documents['asyncapi.realtime.v1.json']

    const analyticsPaths = analytics.paths as Record<string, { post: { operationId: string } }>
    const realtimePaths = realtime.paths as Record<string, { get?: { operationId: string }, post?: { operationId: string } }>
    expect(analyticsPaths['/api/analytics/v1/sites/{siteId}/rows']?.post.operationId).toBe('analytics.rows.query')
    expect(realtimePaths['/api/realtime/v1/stream/head']?.get?.operationId).toBe('realtime.stream.head.get')
    expect(realtimePaths['/api/realtime/v1/tickets']?.post?.operationId).toBe('realtime.tickets.create')
    expect(asyncapi).toHaveProperty('servers.production.host', 'gscdump.com')
    expect(asyncapi).toHaveProperty('servers.production.pathname', '/ws/v1')
    expect(asyncapi).toHaveProperty('channels.notifications.address', '/')
    expect(asyncapi).toHaveProperty(['x-gscdump-event-semantics', 'site.analytics.ready'], {
      delivery: 'durable',
      baseChanges: ['site.analytics', 'site.lifecycle'],
    })
    const analyticsRequestSchema = (analyticsPaths['/api/analytics/v1/sites/{siteId}/rows']?.post as {
      requestBody: { content: { 'application/json': { schema: Record<string, unknown> } } }
    }).requestBody.content['application/json'].schema
    const filterReference = ((analyticsRequestSchema.properties as Record<string, unknown>).filter as { $ref: string }).$ref
    expect(filterReference).toBe('#/components/schemas/analytics.rows.query.request.body.__schema0')
    expect(analyticsRequestSchema).not.toHaveProperty('$defs')
    const componentSchemas = (analytics.components as { schemas: Record<string, unknown> }).schemas
    const filterGroup = componentSchemas['analytics.rows.query.request.body.__schema0'] as {
      anyOf: Array<{
        properties: {
          _filters: {
            minItems?: number
            maxItems?: number
            items: { anyOf: Array<Record<string, unknown>> }
          }
          _nestedGroups?: { minItems?: number }
        }
      }>
    }
    expect(filterGroup.anyOf[0]?.properties._filters.minItems).toBe(1)
    expect(filterGroup.anyOf[1]?.properties._filters.maxItems).toBe(0)
    expect(filterGroup.anyOf[1]?.properties._nestedGroups?.minItems).toBe(1)
    const betweenLeaf = filterGroup.anyOf[0]?.properties._filters.items.anyOf.find((candidate) => {
      const properties = candidate.properties as Record<string, { enum?: string[] }> | undefined
      return properties?.operator?.enum?.includes('between')
    })
    expect(betweenLeaf?.required).toContain('expression2')

    const analyticsError = componentSchemas['analytics.rows.query.error'] as {
      properties: { error: { properties: { code: { enum: string[] } }, required: string[] } }
    }
    expect(analyticsError.properties.error.required).toContain('details')
    expect(analyticsError.properties.error.properties.code.enum).toContain('site_not_found')
    expect(analyticsError.properties.error.properties.code.enum).not.toContain('user_not_found')

    const durableEventSchema = findContractObject(asyncapi, (candidate) => {
      const properties = candidate.properties as Record<string, Record<string, unknown>> | undefined
      return properties?.delivery?.const === 'durable' && properties.changes !== undefined
    })
    const durableProperties = durableEventSchema?.properties as Record<string, Record<string, unknown>>
    expect(durableProperties.changes).toHaveProperty('minItems', 1)
  })

  it('keeps every representative example executable', () => {
    const protocol = createGscdumpV1Protocol()
    for (const surface of Object.values(protocol.surfaces)) {
      for (const operation of Object.values(surface.operations)) {
        const request = operation.docs.examples.request as {
          params?: unknown
          query?: unknown
          headers?: unknown
          body?: unknown
        }
        if (operation.request.params)
          operation.request.params.parse(request.params)
        if (operation.request.query)
          operation.request.query.parse(request.query ?? {})
        if (operation.request.headers)
          operation.request.headers.parse(request.headers ?? {})
        if (operation.request.body)
          operation.request.body.parse(request.body)
        const response = Object.values(operation.responses)[0]!
        response.producer.parse(operation.docs.examples.response)
      }
    }
  })
})
