import type { GscdumpAvailableSite, GscdumpSiteRegistration } from '../src'
import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const meta = { requestId: 'req_available_sites', surface: 'partner', version: '1.0' } as const

describe('available Sites sync states', () => {
  it.each(['idle', 'partial'] as const)('preserves %s in available Sites and token refresh responses', (syncStatus) => {
    const site = {
      siteUrl: 'https://example.com/',
      permissionLevel: 'siteOwner',
      registered: true,
      siteId: 's_01',
      syncStatus,
    }
    const operations = createGscdumpV1Protocol().surfaces.partner.operations
    const available = operations.listAvailableSites.responses[200]
    const updated = operations.updateUserTokens.responses[200]
    for (const schema of [available.producer, available.client]) {
      expect(schema.parse({ data: { sites: [site] }, meta }).data.sites).toEqual([site])
    }
    for (const schema of [updated.producer, updated.client]) {
      expect(schema.parse({ data: { userId: 'u_01', updated: true, sites: [site] }, meta }).data.sites).toEqual([site])
    }
    const typed: GscdumpAvailableSite = available.producer.parse({ data: { sites: [site] }, meta }).data.sites[0]!
    expect(typed.syncStatus).toBe(syncStatus)
  })

  it('rejects unknown sync states from the producer', () => {
    const schema = createGscdumpV1Protocol().surfaces.partner.operations.listAvailableSites.responses[200].producer
    expect(() => schema.parse({ data: { sites: [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner', registered: true, syncStatus: 'unknown' }] }, meta })).toThrow()
  })

  it('preserves partial when registering an existing Site', () => {
    const response = createGscdumpV1Protocol().surfaces.partner.operations.createSite.responses[200]
    const registration = { siteId: 's_01', status: 'partial', existing: true, message: 'Site already registered' }
    const parsed: GscdumpSiteRegistration = response.producer.parse({ data: registration, meta }).data
    expect(parsed).toEqual(registration)
    expect(response.client.parse({ data: registration, meta }).data).toEqual(registration)
  })
})
