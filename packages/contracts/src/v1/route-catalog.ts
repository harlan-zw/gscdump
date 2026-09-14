import type { HttpV1RouteSurfaceName } from './route-surfaces'
import { unknownHttpV1OperationError } from './http-operation-error'
import { GSCDUMP_V1_ROUTE_SURFACES } from './route-surfaces'

export type HttpV1RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST'
export type { HttpV1RouteSurfaceName } from './route-surfaces'

interface HttpV1RouteDefinition {
  surface: HttpV1RouteSurfaceName
  method: HttpV1RouteMethod
  template: `/${string}`
}

export const GSCDUMP_V1_ROUTE_CATALOG = {
  surfaces: GSCDUMP_V1_ROUTE_SURFACES,
  operations: {
    'partner.users.lifecycle.get': { surface: 'partner', method: 'GET', template: '/users/{userId}/lifecycle' },
    'partner.users.sites.available.list': { surface: 'partner', method: 'GET', template: '/users/{userId}/available-sites' },
    'partner.users.sites.create': { surface: 'partner', method: 'POST', template: '/users/{userId}/sites' },
    'partner.users.create': { surface: 'partner', method: 'POST', template: '/users' },
    'partner.users.tokens.update': { surface: 'partner', method: 'PATCH', template: '/users/{userId}/tokens' },
    'partner.sites.indexing.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/indexing' },
    'partner.sites.indexing.urls.list': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/indexing/urls' },
    'partner.sites.bing.data.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/bing/data' },
    'partner.sites.indexing.bing.evidence.list': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/indexing/bing/evidence' },
    'partner.sites.indexing.bing.connection.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/indexing/bing/connection' },
    'partner.sites.indexing.bing.connection.verify': { surface: 'partner', method: 'POST', template: '/sites/{siteId}/indexing/bing/connection/verify' },
    'partner.sites.indexing.transitions.list': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/indexing/transitions' },
    'partner.sites.indexing.diagnostics.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/indexing/diagnostics' },
    'partner.sites.sitemaps.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/sitemaps' },
    'partner.sites.sitemaps.changes.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/sitemaps/changes' },
    'partner.sites.analysis.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/analysis' },
    'partner.sites.analysis.bundle.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/analysis/bundle' },
    'partner.sites.delete': { surface: 'partner', method: 'DELETE', template: '/sites/{siteId}' },
    'partner.sites.canonical.mismatches.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/canonical-mismatches' },
    'partner.sites.indexing.inspect.create': { surface: 'partner', method: 'POST', template: '/sites/{siteId}/indexing/inspect' },
    'partner.sites.permission.recover': { surface: 'partner', method: 'POST', template: '/sites/{siteId}/permission/recover' },
    'partner.sites.keyword.sparklines.query': { surface: 'partner', method: 'POST', template: '/sites/{siteId}/keyword-sparklines' },
    'partner.sites.query.trend.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/query-trend' },
    'partner.sites.page.trend.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/page-trend' },
    'partner.sites.content.velocity.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/content-velocity' },
    'partner.sites.ctr.curve.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/ctr-curve' },
    'partner.sites.dark.traffic.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/dark-traffic' },
    'partner.sites.device.gap.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/device-gap' },
    'partner.sites.keyword.breadth.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/keyword-breadth' },
    'partner.sites.position.distribution.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/position-distribution' },
    'partner.sites.top.association.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/top-association' },
    'partner.sites.index.percent.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/index-percent' },
    'partner.sites.sitemaps.action.create': { surface: 'partner', method: 'POST', template: '/sites/{siteId}/sitemaps/actions' },
    'partner.sites.sitemaps.membership.query': { surface: 'partner', method: 'POST', template: '/sites/{siteId}/sitemaps/membership' },
    'partner.sites.sitemaps.urls.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/sitemaps/urls' },
    'partner.sites.sitemaps.export.get': { surface: 'partner', method: 'GET', template: '/sites/{siteId}/sitemaps/export' },
    'partner.teams.create': { surface: 'partner', method: 'POST', template: '/teams' },
    'partner.teams.rename': { surface: 'partner', method: 'PATCH', template: '/teams/{teamId}' },
    'partner.teams.delete': { surface: 'partner', method: 'DELETE', template: '/teams/{teamId}' },
    'partner.teams.members.list': { surface: 'partner', method: 'GET', template: '/teams/{teamId}/members' },
    'partner.teams.members.add': { surface: 'partner', method: 'POST', template: '/teams/{teamId}/members' },
    'partner.teams.members.role.update': { surface: 'partner', method: 'PATCH', template: '/teams/{teamId}/members/{userId}' },
    'partner.teams.members.remove': { surface: 'partner', method: 'DELETE', template: '/teams/{teamId}/members/{userId}' },
    'partner.sites.team.update': { surface: 'partner', method: 'PATCH', template: '/sites/{siteId}/team' },
    'partner.teams.catalog.get': { surface: 'partner', method: 'GET', template: '/teams/{teamId}/catalog' },
    'partner.teams.catalog.bind': { surface: 'partner', method: 'POST', template: '/teams/{teamId}/catalog' },
    'partner.users.sites.crosswalk.get': { surface: 'partner', method: 'GET', template: '/users/{userId}/sites/crosswalk' },
    'partner.users.delete': { surface: 'partner', method: 'DELETE', template: '/users/{userId}' },
    'partner.users.verification.token.create': { surface: 'partner', method: 'POST', template: '/users/{userId}/verification-token' },
    'partner.users.sites.verify.create': { surface: 'partner', method: 'POST', template: '/users/{userId}/sites/verify' },
    'analytics.rows.query': { surface: 'analytics', method: 'POST', template: '/sites/{siteId}/rows' },
    'analytics.reports.query': { surface: 'analytics', method: 'POST', template: '/sites/{siteId}/reports' },
    'analytics.reports.detail.query': { surface: 'analytics', method: 'POST', template: '/sites/{siteId}/reports/detail' },
    'realtime.stream.head.get': { surface: 'realtime', method: 'GET', template: '/stream/head' },
    'realtime.tickets.create': { surface: 'realtime', method: 'POST', template: '/tickets' },
  },
} as const satisfies {
  surfaces: typeof GSCDUMP_V1_ROUTE_SURFACES
  operations: Record<`${HttpV1RouteSurfaceName}.${string}`, HttpV1RouteDefinition>
}

export type GscdumpV1RouteOperationId = keyof typeof GSCDUMP_V1_ROUTE_CATALOG.operations

export type GscdumpV1Route<TId extends GscdumpV1RouteOperationId = GscdumpV1RouteOperationId>
  = TId extends GscdumpV1RouteOperationId
    ? { id: TId } & typeof GSCDUMP_V1_ROUTE_CATALOG.operations[TId]
    : never

export function getGscdumpV1Route<const TId extends GscdumpV1RouteOperationId>(
  id: TId,
): GscdumpV1Route<TId> {
  const operations = GSCDUMP_V1_ROUTE_CATALOG.operations as Readonly<Record<string, HttpV1RouteDefinition>>
  if (!Object.hasOwn(operations, id))
    throw unknownHttpV1OperationError(id)
  return { id, ...operations[id]! } as GscdumpV1Route<TId>
}

export function gscdumpV1OperationRoute<const TId extends GscdumpV1RouteOperationId>(
  id: TId,
): Pick<GscdumpV1Route<TId>, 'id' | 'method'> & { path: GscdumpV1Route<TId>['template'] } {
  const route = getGscdumpV1Route(id)
  return { id, method: route.method, path: route.template }
}

export function gscdumpV1Surface<const TName extends HttpV1RouteSurfaceName>(name: TName): {
  name: TName
  prefix: typeof GSCDUMP_V1_ROUTE_CATALOG.surfaces[TName]['prefix']
  version: typeof GSCDUMP_V1_ROUTE_CATALOG.surfaces[TName]['version']
} {
  return { name, ...GSCDUMP_V1_ROUTE_CATALOG.surfaces[name] }
}
