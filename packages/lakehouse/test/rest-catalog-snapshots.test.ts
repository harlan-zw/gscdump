import { afterEach, describe, expect, it, vi } from 'vitest'
import { restCatalogLoadTable } from '../src/unsafe-raw'

const currentId = 6_000_000_000_000_007_919n
const oldId = 6_000_000_000_000_000_000n
const context = {
  type: 'rest' as const,
  url: 'https://catalog.example',
  prefix: 'warehouse',
  defaults: {},
  overrides: {},
  requestInit: { headers: { authorization: 'Bearer test-token' } },
}

function response(refsOnly: boolean) {
  const snapshots = refsOnly ? `${currentId}` : `${oldId},${currentId}`
  return new Response(`{"metadata-location":"s3://warehouse/metadata/42.json","config":{"region":"auto"},"metadata":{
    "table-uuid":"test-table","current-snapshot-id":${currentId},
    "refs":{"main":{"snapshot-id":${currentId},"type":"branch"}},
    "snapshots":[${snapshots.split(',').map(id => `{"snapshot-id":${id}}`).join(',')}]
  }}`)
}

afterEach(() => vi.unstubAllGlobals())

describe('rest catalog snapshot selection', () => {
  it('loads referenced snapshots through the signed table URL', async () => {
    const requests: { url: string, authorization: string | null }[] = []
    const signedUrls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      return response(new URL(url).searchParams.get('snapshots') === 'refs')
    })
    const signRequest = async (url: string, init?: RequestInit) => {
      signedUrls.push(url)
      return init ?? {}
    }

    const result = await restCatalogLoadTable({ ...context, signRequest }, {
      namespace: ['team name', 'gsc'],
      table: 'pages/overlay',
      snapshots: 'refs',
    })

    expect(requests).toEqual([{
      url: 'https://catalog.example/v1/warehouse/namespaces/team%20name%1Fgsc/tables/pages%2Foverlay?snapshots=refs',
      authorization: 'Bearer test-token',
    }])
    expect(signedUrls).toEqual(requests.map(request => request.url))
    expect(result.metadata.snapshots?.map(snapshot => snapshot['snapshot-id'])).toEqual([currentId])
    expect(result.metadata['current-snapshot-id']).toBe(currentId)
    expect(result.metadataLocation).toBe('s3://warehouse/metadata/42.json')
    expect(result.config).toEqual({ region: 'auto' })
  })

  it.each([undefined, 'all'] as const)('preserves historical snapshots for %s', async (snapshots) => {
    vi.stubGlobal('fetch', async (url: string) => response(new URL(url).searchParams.get('snapshots') === 'refs'))

    const result = await restCatalogLoadTable(context, { namespace: 'gsc', table: 'pages', snapshots })

    expect(result.metadata.snapshots?.map(snapshot => snapshot['snapshot-id'])).toEqual([oldId, currentId])
  })

  it('fetches each referenced-snapshot read and propagates provider failures', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => ++calls === 1
      ? response(true)
      : new Response('{"error":{"code":403,"type":"ForbiddenException","message":"Access denied"}}', { status: 403 }))

    await restCatalogLoadTable(context, { namespace: 'gsc', table: 'pages', snapshots: 'refs' })
    await expect(restCatalogLoadTable(context, { namespace: 'gsc', table: 'pages', snapshots: 'refs' })).rejects.toMatchObject({ status: 403 })

    expect(calls).toBe(2)
  })
})
