import type {
  GscdumpV1Route,
  GscdumpV1RouteOperationId,
} from './route-catalog'
import { serializeHttpV1PathSegment } from './path-segment'
import {
  getGscdumpV1Route,
  GSCDUMP_V1_ROUTE_CATALOG,
} from './route-catalog'

export {
  isUnknownHttpV1OperationError,
} from './http-operation-error'
export type {
  UnknownHttpV1OperationError,
} from './http-operation-error'
export type {
  GscdumpV1Route,
  GscdumpV1RouteOperationId,
  HttpV1RouteMethod,
} from './route-catalog'
export type { HttpV1RouteSurfaceName } from './route-surfaces'

type PathParameterNames<TTemplate extends string>
  = TTemplate extends `${string}{${infer TName}}${infer TRest}`
    ? TName | PathParameterNames<TRest>
    : never

export type GscdumpV1PathParams<TId extends GscdumpV1RouteOperationId>
  = [PathParameterNames<GscdumpV1Route<TId>['template']>] extends [never]
    ? undefined
    : { [TName in PathParameterNames<GscdumpV1Route<TId>['template']>]: string | number }

export type GscdumpV1PathArguments<TId extends GscdumpV1RouteOperationId>
  = GscdumpV1PathParams<TId> extends undefined
    ? [params?: undefined]
    : [params: GscdumpV1PathParams<TId>]

export interface GscdumpV1PathsOptions {
  /** Root replacing the contract's `/api` segment. */
  apiRoot?: string
}

export type GscdumpV1PathOperation<TId extends GscdumpV1RouteOperationId = GscdumpV1RouteOperationId>
  = GscdumpV1Route<TId> & {
    prefix: typeof GSCDUMP_V1_ROUTE_CATALOG.surfaces[GscdumpV1Route<TId>['surface']]['prefix']
  }

export interface GscdumpV1Paths {
  operation: <const TId extends GscdumpV1RouteOperationId>(id: TId) => GscdumpV1PathOperation<TId>
  path: <const TId extends GscdumpV1RouteOperationId>(
    id: TId,
    ...args: GscdumpV1PathArguments<TId>
  ) => string
}

function normalizeApiRoot(apiRoot: string | undefined): string {
  const root = apiRoot ?? '/api'
  if (!root.startsWith('/') || root.startsWith('//') || root.includes('?') || root.includes('#'))
    throw new TypeError('HTTP v1 apiRoot must be an absolute path without a query string or fragment')
  return root === '/' ? '' : root.replace(/\/+$/, '')
}

export function createGscdumpV1Paths(options: GscdumpV1PathsOptions = {}): GscdumpV1Paths {
  const apiRoot = normalizeApiRoot(options.apiRoot)

  function operation<TId extends GscdumpV1RouteOperationId>(id: TId): GscdumpV1PathOperation<TId> {
    const route = getGscdumpV1Route(id)
    return {
      ...route,
      prefix: GSCDUMP_V1_ROUTE_CATALOG.surfaces[route.surface].prefix,
    } as GscdumpV1PathOperation<TId>
  }

  return {
    operation,
    path: (id, ...args) => {
      const route = operation(id)
      const names = [...route.template.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!)
      const params = args[0] as Readonly<Record<string, unknown>> | undefined
      if (names.length === 0) {
        if (params !== undefined)
          throw new TypeError(`${id}: this operation has no path parameters`)
        return `${apiRoot}${route.prefix.slice('/api'.length)}${route.template}`
      }
      if (params === undefined || params === null || typeof params !== 'object' || Array.isArray(params))
        throw new TypeError(`${id}: path parameters are required`)
      const unknownName = Object.keys(params).find(name => !names.includes(name))
      if (unknownName)
        throw new TypeError(`${id}: unknown path parameter ${unknownName}`)
      const relativePath = route.template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
        if (!Object.hasOwn(params, name))
          throw new TypeError(`${id}: path parameter ${name} is required`)
        return serializeHttpV1PathSegment(id, name, params[name])
      })
      return `${apiRoot}${route.prefix.slice('/api'.length)}${relativePath}`
    },
  }
}
