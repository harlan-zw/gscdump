import { bingConnectionV1Schema, createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const meta = {
  requestId: 'req_bing_connection',
  surface: 'partner' as const,
  version: '1.0' as const,
}

const connectedMetadata = {
  scopes: ['webmaster.read'],
  tokenExpiresAt: '2026-08-28T08:00:00.000Z',
  lastEvidenceAt: null,
}

describe('bing connection v1', () => {
  it('parses each connection state as one exact tagged value', () => {
    const states = [
      { _tag: 'disconnected', searchEngine: 'bing' },
      {
        _tag: 'verification-required',
        searchEngine: 'bing',
        remoteSiteUrl: 'https://nuxtseo.com/',
        verified: false,
        verification: {
          _tag: 'cname',
          name: 'abc123',
          value: 'verify.bing.com',
        },
      },
      {
        _tag: 'connected',
        searchEngine: 'bing',
        remoteSiteUrl: 'https://nuxtseo.com/',
        verified: true,
        ...connectedMetadata,
      },
      {
        _tag: 'reauthorization-required',
        searchEngine: 'bing',
        remoteSiteUrl: 'https://nuxtseo.com/',
        verified: true,
        ...connectedMetadata,
      },
      {
        _tag: 'reauthorization-required',
        searchEngine: 'bing',
        remoteSiteUrl: 'https://nuxtseo.com/',
        verified: false,
        ...connectedMetadata,
      },
      {
        _tag: 'unavailable',
        searchEngine: 'bing',
        remoteSiteUrl: 'https://nuxtseo.com/',
        verified: true,
        reason: 'permission-lost',
        ...connectedMetadata,
      },
    ]

    expect(states.map(state => bingConnectionV1Schema.parse(state))).toEqual(states)
  })

  it('rejects contradictory and non-contract verification states', () => {
    expect(() => bingConnectionV1Schema.parse({
      _tag: 'verification-required',
      searchEngine: 'bing',
      remoteSiteUrl: 'https://nuxtseo.com/',
      verified: true,
      verification: { _tag: 'cname', name: 'abc123', value: 'verify.bing.com' },
    })).toThrow()
    expect(() => bingConnectionV1Schema.parse({
      _tag: 'verification-required',
      searchEngine: 'bing',
      remoteSiteUrl: 'https://nuxtseo.com/',
      verified: false,
      verification: {
        _tag: 'cname',
        name: 'abc123',
        host: 'abc123.nuxtseo.com',
        value: 'verify.bing.com',
      },
    })).toThrow()
    expect(() => bingConnectionV1Schema.parse({
      _tag: 'verification-required',
      searchEngine: 'bing',
      remoteSiteUrl: 'https://nuxtseo.com/',
      verified: false,
      verification: { _tag: 'cname', name: 'ABC123', value: 'verify.bing.com' },
    })).toThrow()
    expect(() => bingConnectionV1Schema.parse({
      _tag: 'unavailable',
      searchEngine: 'bing',
      remoteSiteUrl: 'https://nuxtseo.com/',
      verified: false,
      reason: 'site-unverified',
      ...connectedMetadata,
    })).toThrow()
  })

  it('registers read and verification routes with the same response contract', () => {
    const protocol = createGscdumpV1Protocol()
    const get = protocol.surfaces.partner.operations.getSiteBingConnection
    const verify = protocol.surfaces.partner.operations.verifySiteBingConnection

    expect([get.id, get.method, get.path]).toEqual([
      'partner.sites.indexing.bing.connection.get',
      'GET',
      '/sites/{siteId}/indexing/bing/connection',
    ])
    expect([verify.id, verify.method, verify.path]).toEqual([
      'partner.sites.indexing.bing.connection.verify',
      'POST',
      '/sites/{siteId}/indexing/bing/connection/verify',
    ])
    expect(verify.request.body).toBeNull()
    expect(get.responses[200].producer.parse({
      data: { _tag: 'disconnected', searchEngine: 'bing' },
      meta,
    })).toEqual(verify.responses[200].producer.parse({
      data: { _tag: 'disconnected', searchEngine: 'bing' },
      meta,
    }))
  })
})
