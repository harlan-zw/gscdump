import { describe, expect, it, vi } from 'vitest'
import { adoptCatalog, selfProvisionCatalog, suppliedCatalog } from '../src/provisioning/index'

describe('adoptCatalog', () => {
  it('returns no-catalog when the remote ref is null or incomplete', () => {
    expect(adoptCatalog(null)).toEqual({ _tag: 'no-catalog' })
    expect(adoptCatalog({ catalogUri: null, warehouse: null, bucket: null })).toEqual({ _tag: 'no-catalog' })
  })

  it('adopts a ready, correctly-encoded remote ref', () => {
    const result = adoptCatalog({ catalogUri: 'https://catalog.example/a/b', warehouse: 'a_b', bucket: 'b', keyEncoding: 'int', provisioningState: 'ready' })
    expect(result).toEqual({ _tag: 'adopted', ref: { catalogUri: 'https://catalog.example/a/b', warehouse: 'a_b', bucket: 'b', namespace: 'default' } })
  })

  it('rejects a mismatched key encoding rather than poisoning the catalog', () => {
    const result = adoptCatalog({ catalogUri: 'x', warehouse: 'y', bucket: 'z', keyEncoding: 'string', provisioningState: 'ready' })
    expect(result).toEqual({ _tag: 'rejected', reason: 'key-encoding', detail: expect.stringContaining('string') })
  })

  it('rejects a not-ready remote catalog', () => {
    const result = adoptCatalog({ catalogUri: 'x', warehouse: 'y', bucket: 'z', provisioningState: 'provisioning' })
    expect(result).toEqual({ _tag: 'rejected', reason: 'not-ready', detail: expect.stringContaining('provisioning') })
  })
})

describe('suppliedCatalog', () => {
  it('passes through a complete ref', () => {
    const ref = { catalogUri: 'x', warehouse: 'y', bucket: 'z', namespace: 'crawl' }
    expect(suppliedCatalog(ref)).toBe(ref)
  })

  it('throws on an incomplete ref', () => {
    expect(() => suppliedCatalog({ catalogUri: '', warehouse: 'y', bucket: 'z', namespace: 'crawl' })).toThrow()
  })
})

describe('selfProvisionCatalog', () => {
  it('creates the bucket, sets CORS, enables the catalog, sets the credential, then enables maintenance', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })

    const ref = await selfProvisionCatalog({
      creds: { accountId: 'acct', apiToken: 'mgmt', catalogToken: 'cat', compactionCredentialToken: 'cred' },
      bucket: 'gsc-team-1-int',
      namespace: 'crawl',
      corsOrigins: ['https://nuxtseo.com'],
      fetch: fetchImpl as unknown as typeof fetch,
      onWarn: () => {},
    })

    expect(ref).toEqual({
      catalogUri: 'https://catalog.cloudflarestorage.com/acct/gsc-team-1-int',
      warehouse: 'acct_gsc-team-1-int',
      bucket: 'gsc-team-1-int',
      namespace: 'crawl',
    })
    expect(calls).toEqual([
      'POST /client/v4/accounts/acct/r2/buckets',
      'PUT /client/v4/accounts/acct/r2/buckets/gsc-team-1-int/cors',
      'POST /client/v4/accounts/acct/r2-catalog/gsc-team-1-int/enable',
      'POST /client/v4/accounts/acct/r2-catalog/gsc-team-1-int/credential',
      'POST /client/v4/accounts/acct/r2-catalog/gsc-team-1-int/maintenance-configs',
    ])
  })

  it('treats "already exists" as success (idempotent re-run)', async () => {
    const fetchImpl = vi.fn(async () => new Response('already exists', { status: 409 }))
    await expect(selfProvisionCatalog({
      creds: { accountId: 'acct', apiToken: 'mgmt', catalogToken: 'cat' },
      bucket: 'gsc-team-1-int',
      namespace: 'crawl',
      corsOrigins: [],
      fetch: fetchImpl as unknown as typeof fetch,
      onWarn: () => {},
    })).resolves.toBeDefined()
  })

  it('does not throw when the best-effort maintenance step fails', async () => {
    const warnings: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).pathname.includes('maintenance-configs'))
        return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    await expect(selfProvisionCatalog({
      creds: { accountId: 'acct', apiToken: 'mgmt', catalogToken: 'cat', compactionCredentialToken: 'cred' },
      bucket: 'b',
      namespace: 'crawl',
      corsOrigins: [],
      fetch: fetchImpl as unknown as typeof fetch,
      onWarn: m => warnings.push(m),
    })).resolves.toBeDefined()
    expect(warnings.some(w => w.includes('maintenance-configs'))).toBe(true)
  })
})
