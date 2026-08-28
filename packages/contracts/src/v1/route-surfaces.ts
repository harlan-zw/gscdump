import { GSCDUMP_HTTP_V1_VERSION } from './version'

export const HTTP_V1_ROUTE_SURFACE_NAMES = ['partner', 'analytics', 'realtime'] as const
export type HttpV1RouteSurfaceName = typeof HTTP_V1_ROUTE_SURFACE_NAMES[number]

type HttpV1RouteSurfaces = {
  [TName in HttpV1RouteSurfaceName]: {
    prefix: `/api/${TName}/v1`
    version: typeof GSCDUMP_HTTP_V1_VERSION
  }
}

export const GSCDUMP_V1_ROUTE_SURFACES = {
  partner: { prefix: '/api/partner/v1', version: GSCDUMP_HTTP_V1_VERSION },
  analytics: { prefix: '/api/analytics/v1', version: GSCDUMP_HTTP_V1_VERSION },
  realtime: { prefix: '/api/realtime/v1', version: GSCDUMP_HTTP_V1_VERSION },
} as const satisfies HttpV1RouteSurfaces
