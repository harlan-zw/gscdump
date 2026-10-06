// The devframe's source: the public v1 API with a credential held in the dev
// server process. It lists Sites through `/api/cli/me`, as the CLI does.

import type { GscdumpV1Client } from '@gscdump/sdk/v1'
import type { GscdumpCredential } from '../credential'
import type { DateWindow } from '../shared/protocol'
import type { RowsRead, SitesRead, StatsSource } from '../source'
import { parseRecordReadRefusal } from '@gscdump/contracts'
import { createGscdumpV1Client, isGscdumpV1Error } from '@gscdump/sdk/v1'
import { readAccount } from '../account'
import { bearerOf, dashboardOrigin, resolveCredential } from '../credential'

export interface HostedSourceOptions {
  /** A gscdump user API key. Defaults to `GSCDUMP_API_KEY`, then the CLI's Hosted login. */
  apiKey?: string
  /** Defaults to `GSCDUMP_API_ROOT`, then `https://gscdump.com/api`. */
  apiRoot?: string
}

export interface HostedSourceDeps {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  /** Reads the CLI's saved authentication. Resolves `null` when the CLI never logged in. */
  readCliAuthentication: () => Promise<unknown>
}

interface RowsBody {
  dimensions: ['date' | 'query']
  filter: { _filters: { dimension: string, operator: string, expression: string, expression2?: string }[] }
  orderBy: { column: 'date' | 'clicks', dir: 'asc' | 'desc' }
  rowLimit: number
}

function rowsBody(dimension: 'date' | 'query', path: string, window: DateWindow, rowLimit: number): RowsBody {
  return {
    dimensions: [dimension],
    filter: {
      _filters: [
        { dimension: 'date', operator: 'between', expression: window.start, expression2: window.end },
        { dimension: 'page', operator: 'equals', expression: path },
      ],
    },
    orderBy: dimension === 'date' ? { column: 'date', dir: 'asc' } : { column: 'clicks', dir: 'desc' },
    rowLimit,
  }
}

export function createHostedSource(options: HostedSourceOptions, deps: HostedSourceDeps): StatsSource {
  const apiRoot = (options.apiRoot ?? deps.env.GSCDUMP_API_ROOT ?? 'https://gscdump.com/api').replace(/\/+$/, '')
  /** Set by the last Site read that found a working credential. */
  let ready: { credential: GscdumpCredential, client: GscdumpV1Client } | null = null

  async function sites(): Promise<SitesRead> {
    const read = await readSites()
    if (read._tag === 'Blocked')
      ready = null
    return read
  }

  async function readSites(): Promise<SitesRead> {
    const credential = await resolveCredential({
      apiKey: options.apiKey,
      apiRoot: options.apiRoot,
      env: deps.env,
      readCliAuthentication: deps.readCliAuthentication,
    })
    if (!credential)
      return { _tag: 'Blocked', context: { _tag: 'CredentialMissing' } }
    const account = await readAccount(credential, deps.fetch)
    if (account._tag === 'Rejected')
      return { _tag: 'Blocked', context: { _tag: 'CredentialRejected', source: credential.source } }
    if (account._tag === 'Unavailable')
      return { _tag: 'Blocked', context: { _tag: 'Unavailable', message: account.message } }
    ready = { credential, client: createGscdumpV1Client({ apiRoot: credential.apiRoot, credential: bearerOf(credential), fetch: deps.fetch }) }
    return { _tag: 'Ok', sites: account.sites }
  }

  async function readRows(siteId: string, body: RowsBody): Promise<RowsRead> {
    if (!ready)
      return { _tag: 'Unauthorized', context: { _tag: 'CredentialMissing' } }
    const { client, credential } = ready
    return client.queryAnalyticsRows({ params: { siteId }, body: body as never }).then(
      (response): RowsRead => ({ _tag: 'Ok', rows: response.data.rows as Record<string, unknown>[] }),
      (error: unknown): RowsRead => {
        if (!isGscdumpV1Error(error))
          throw error
        const refusal = parseRecordReadRefusal(error.details)
        if (refusal)
          return { _tag: 'Refused', refusal }
        // The SDK already waited out `Retry-After` and retried before it gave up.
        if (error.code === 'rate_limited')
          return { _tag: 'RateLimited' }
        if (error.status === 401 || error.status === 403)
          return { _tag: 'Unauthorized', context: { _tag: 'CredentialRejected', source: credential.source } }
        return { _tag: 'Failed', message: error.message, requestId: error.requestId ?? null }
      },
    )
  }

  return {
    sites,
    dailyRows: (siteId, path, window) => readRows(siteId, rowsBody('date', path, window, 400)),
    queryRows: (siteId, path, window, limit) => readRows(siteId, rowsBody('query', path, window, limit)),
    get dashboardOrigin() {
      return dashboardOrigin(ready?.credential.apiRoot ?? apiRoot)
    },
  }
}
