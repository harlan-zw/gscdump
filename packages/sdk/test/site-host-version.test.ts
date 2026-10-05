import { siteVersionIdentityResponseSchema, siteVersionPreviewSchema } from '@gscdump/contracts/partner'
import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { expect, it, vi } from 'vitest'

it('admits ongoing verified coverage without broadening a correction plan', () => {
  const identity = {
    siteId: 's_fixture',
    userId: 'u_fixture',
    teamId: 't_fixture',
    requestedUrl: 'https://www.example.test/',
    catalogSiteId: 17,
    warehouse: 'fixture_catalog',
    namespace: 'gsc_v1',
    version: 1,
    revision: 1,
    catalogRevision: 1,
    dataVersion: 1,
  }
  const window = { startDate: '2026-07-01', endDate: '2026-10-02' }
  expect(siteVersionIdentityResponseSchema.safeParse({ identity, coverage: { _tag: 'verified', window } }).success)
    .toBe(true)
  expect(siteVersionPreviewSchema.safeParse({
    _tag: 'eligible',
    identity,
    window,
    requestedUrl: identity.requestedUrl,
    requiredSlices: [{ table: 'dates', searchType: 'web' }],
    candidateNamespace: 'gsc_v2',
    candidateVersion: 2,
  }).success).toBe(false)
})

it('previews exact-host correction through the partner protocol without writing', async () => {
  const identity = {
    siteId: 's_fixture',
    userId: 'u_fixture',
    teamId: 't_fixture',
    requestedUrl: 'https://example.test/',
    catalogSiteId: 17,
    warehouse: 'fixture_catalog',
    namespace: 'gsc',
    version: 0,
    revision: 1,
    catalogRevision: 1,
    dataVersion: 1,
  }
  const result = {
    _tag: 'eligible',
    identity,
    requestedUrl: 'https://www.example.test/',
    window: { startDate: '2026-09-05', endDate: '2026-10-02' },
    requiredSlices: [{ table: 'dates', searchType: 'web' }],
    candidateNamespace: 'gsc_v1',
    candidateVersion: 1,
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(String(url)).toBe('https://gscdump.com/api/partner/v1/sites/s_fixture/registered-host/preview')
    expect(init?.method).toBe('POST')
    return new Response(JSON.stringify({ data: result, meta: { requestId: 'req_fixture', surface: 'partner', version: '1.0' } }), {
      headers: { 'content-type': 'application/json' },
    })
  })
  const client = createGscdumpV1Client({ credential: 'fixture_partner_key', fetch })
  await expect(client.execute('partner.sites.registered_host.preview', {
    params: { siteId: 's_fixture' },
    body: { requestedUrl: result.requestedUrl, window: result.window, catalogSiteId: 17 },
  })).resolves.toMatchObject({ data: result })
  expect(fetch).toHaveBeenCalledOnce()
})

it.each(['https://www.example.test/path', 'https://www.example.test/#scope', 'ftp://www.example.test/']) (
  'rejects invalid correction input before transport: %s',
  async (requestedUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createGscdumpV1Client({ credential: 'fixture_partner_key', fetch })
    await expect(client.execute('partner.sites.registered_host.preview', {
      params: { siteId: 's_fixture' },
      body: { requestedUrl, window: { startDate: '2026-09-05', endDate: '2026-10-02' }, catalogSiteId: 17 },
    })).rejects.toMatchObject({ code: 'request_validation' })
    expect(fetch).not.toHaveBeenCalled()
  },
)

it('preserves the data cache clock independently of the registered binding', async () => {
  const identity = {
    siteId: 's_fixture',
    userId: 'u_fixture',
    teamId: 't_fixture',
    requestedUrl: 'https://www.example.test/',
    catalogSiteId: 17,
    warehouse: 'fixture_catalog',
    namespace: 'gsc_v1',
    version: 1,
    revision: 3,
    catalogRevision: 4,
    dataVersion: 7,
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
    data: { identity, coverage: { _tag: 'verified', window: { startDate: '2026-09-05', endDate: '2026-10-02' } } },
    meta: { requestId: 'req_fixture', surface: 'partner', version: '1.0' },
  }), { headers: { 'content-type': 'application/json' } }))
  const client = createGscdumpV1Client({ credential: 'fixture_partner_key', fetch })
  await expect(client.execute('partner.sites.registered_host.identity.get', { params: { siteId: 's_fixture' } }))
    .resolves
    .toMatchObject({ data: { identity: { version: 1, revision: 3, catalogRevision: 4, dataVersion: 7 } } })
  identity.dataVersion = 8
  await expect(client.execute('partner.sites.registered_host.identity.get', { params: { siteId: 's_fixture' } }))
    .resolves
    .toMatchObject({ data: { identity: { version: 1, revision: 3, catalogRevision: 4, dataVersion: 8 } } })
})
