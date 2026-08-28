import type { GscdumpV1OperationId } from '@gscdump/contracts/v1/http'
import type {
  GscdumpV1PathArguments,
  GscdumpV1RouteOperationId,
} from '@gscdump/contracts/v1/paths'
import {
  buildHttpOperationPath,
  createGscdumpV1Protocol,
  HTTP_V1_SURFACES,
  isUnknownHttpV1OperationError as isFullProtocolUnknownOperationError,
} from '@gscdump/contracts/v1/http'
import {
  createGscdumpV1Paths,
  isUnknownHttpV1OperationError,
} from '@gscdump/contracts/v1/paths'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { GSCDUMP_V1_ROUTE_CATALOG } from '../src/v1/route-catalog'

describe('@gscdump/contracts/v1/paths', () => {
  it('builds default and mounted paths from operation IDs', () => {
    const canonical = createGscdumpV1Paths()
    const mounted = createGscdumpV1Paths({ apiRoot: '/api/_gscdump/' })

    expect(canonical.path('partner.users.lifecycle.get', { userId: 'u_01' }))
      .toBe('/api/partner/v1/users/u_01/lifecycle')
    expect(mounted.path('analytics.rows.query', { siteId: 's_01' }))
      .toBe('/api/_gscdump/analytics/v1/sites/s_01/rows')
    expect(mounted.path('realtime.tickets.create'))
      .toBe('/api/_gscdump/realtime/v1/tickets')
  })

  it('encodes each path parameter as one safe segment', () => {
    const paths = createGscdumpV1Paths()

    expect(paths.path('partner.teams.members.role.update', {
      teamId: 'team/a b',
      userId: 'user?\'#',
    })).toBe('/api/partner/v1/teams/team%2Fa%20b/members/user%3F\'%23')
  })

  it('serializes path segments exactly like the schema registry', () => {
    const protocol = createGscdumpV1Protocol()
    const surface = protocol.surfaces.analytics
    const operation = {
      ...surface.operations.queryRows,
      request: {
        ...surface.operations.queryRows.request,
        params: z.strictObject({ siteId: z.string() }),
      },
    }
    const paths = createGscdumpV1Paths()
    const params = { siteId: 'site/\'value' }

    expect(paths.path('analytics.rows.query', params))
      .toBe(buildHttpOperationPath(surface, operation, params))
  })

  it('keeps operation metadata available without the schema protocol', () => {
    const operation = createGscdumpV1Paths().operation('analytics.rows.query')

    expect(operation).toEqual({
      id: 'analytics.rows.query',
      method: 'POST',
      prefix: '/api/analytics/v1',
      surface: 'analytics',
      template: '/sites/{siteId}/rows',
    })
  })

  it('fails for stale IDs and unsafe runtime parameters', () => {
    const paths = createGscdumpV1Paths()
    const stale = 'partner.sites.removed.get' as GscdumpV1RouteOperationId
    const untypedPath = paths.path as unknown as (id: string, params?: unknown) => string

    const failure = (() => {
      try {
        return paths.path(stale)
      }
      catch (cause) {
        return cause
      }
    })()
    expect(isUnknownHttpV1OperationError(failure)).toBe(true)
    expect(isFullProtocolUnknownOperationError(failure)).toBe(true)
    expect(() => untypedPath('analytics.rows.query'))
      .toThrow(/path parameters are required/)
    expect(() => untypedPath('realtime.tickets.create', { query: 'owned-by-caller' }))
      .toThrow(/no path parameters/)
    expect(() => createGscdumpV1Paths({ apiRoot: '/api?query=caller-owned' }))
      .toThrow(/without a query string/)
  })

  it('requires every template parameter at compile time', () => {
    expectTypeOf<GscdumpV1PathArguments<'analytics.rows.query'>>()
      .toEqualTypeOf<[params: { siteId: string | number }]>()
    expectTypeOf<GscdumpV1PathArguments<'partner.teams.members.role.update'>>()
      .toEqualTypeOf<[params: { teamId: string | number, userId: string | number }]>()
    expectTypeOf<GscdumpV1PathArguments<'realtime.tickets.create'>>()
      .toEqualTypeOf<[params?: undefined]>()
    expectTypeOf<GscdumpV1RouteOperationId>().toEqualTypeOf<GscdumpV1OperationId>()
    expectTypeOf(HTTP_V1_SURFACES)
      .toEqualTypeOf<readonly ['partner', 'analytics', 'realtime']>()
  })

  it('keeps the schema protocol in parity with the route catalog', () => {
    const protocol = createGscdumpV1Protocol()
    const protocolRoutes = Object.values(protocol.surfaces)
      .flatMap(surface => Object.values(surface.operations).map(operation => ({
        id: operation.id,
        method: operation.method,
        prefix: surface.prefix,
        surface: surface.name,
        template: operation.path,
      })))
      .sort((left, right) => left.id.localeCompare(right.id))
    const catalogRoutes = Object.entries(GSCDUMP_V1_ROUTE_CATALOG.operations)
      .map(([id, operation]) => ({
        id,
        method: operation.method,
        prefix: GSCDUMP_V1_ROUTE_CATALOG.surfaces[operation.surface].prefix,
        surface: operation.surface,
        template: operation.template,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))

    expect(protocolRoutes).toEqual(catalogRoutes)
  })
})
