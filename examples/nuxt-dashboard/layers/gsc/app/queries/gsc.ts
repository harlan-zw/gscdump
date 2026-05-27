// Minimal `gscQueries` stub. The full implementation in nuxtseo.com wires
// every RPC endpoint via `nuxt-use-query/rpc`; this stub satisfies the typed
// shape consumed by the example dashboard (chiefly `analysisSources`).
// TODO: port from nuxtseo.com

import { defineNuxtQueryGroup, defineNuxtRpcQuery } from 'nuxt-use-query/rpc'
import { z } from 'zod'

const passthrough = z.any()

function key(...parts: unknown[]): unknown[] {
  return parts
}

export const gscQueries = defineNuxtQueryGroup('gsc', {
  whoami: () => defineNuxtRpcQuery({
    key: key('gsc', 'whoami'),
    path: '/api/__gsc/whoami',
    response: passthrough,
  }),
  sites: () => defineNuxtRpcQuery({
    key: key('gsc', 'sites'),
    path: '/api/__gsc/sites',
    response: passthrough,
  }),
  analysisSources: (
    siteId: string,
    tables?: unknown,
    options?: { searchType?: string, start?: string, end?: string, startDate?: string, endDate?: string },
  ) => defineNuxtRpcQuery({
    key: key('gsc', 'analysis-sources', siteId, tables, options),
    path: `/api/__gsc/sites/${siteId}/analysis-sources`,
    response: passthrough,
  }),
  sourceInfo: (siteId: string, options?: unknown) => defineNuxtRpcQuery({
    key: key('gsc', 'source-info', siteId, options),
    path: `/api/__gsc/sites/${siteId}/source-info`,
    response: passthrough,
  }),
  countries: (siteId: string, range?: { start: string, end: string }) => defineNuxtRpcQuery({
    key: key('gsc', 'countries', siteId, range),
    path: `/api/__gsc/sites/${siteId}/countries`,
    response: passthrough,
  }),
  sitemaps: (siteId: string) => defineNuxtRpcQuery({
    key: key('gsc', 'sitemaps', siteId),
    path: `/api/__gsc/sites/${siteId}/sitemaps`,
    response: passthrough,
  }),
  inspectionHistory: (siteId: string, urlHash: string) => defineNuxtRpcQuery({
    key: key('gsc', 'inspection-history', siteId, urlHash),
    path: `/api/__gsc/sites/${siteId}/inspections/${urlHash}`,
    response: passthrough,
  }),
})
