import {
  createGscdumpV1Protocol,
  createHttpV1Registry,
} from '@gscdump/contracts/v1/http'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('@gscdump/contracts/v1/http registry', () => {
  const registry = createHttpV1Registry(createGscdumpV1Protocol())

  it('looks up one operation by its stable ID', () => {
    const entry = registry.operation('analytics.rows.query')

    expect(entry.operation.id).toBe('analytics.rows.query')
    expect(entry.surface.name).toBe('analytics')
    expectTypeOf(entry.operation.id).toEqualTypeOf<'analytics.rows.query'>()
    expectTypeOf(entry.surface.name).toEqualTypeOf<'analytics'>()
  })

  it('resolves exact routes inside one operation allowlist', () => {
    const allow = [
      'analytics.rows.query',
      'partner.users.lifecycle.get',
    ] as const

    const resolved = registry.resolve({
      method: 'GET',
      surface: 'partner',
      path: 'users/u_01/lifecycle',
    }, { allow })

    expect(resolved).toMatchObject({
      operation: { id: 'partner.users.lifecycle.get' },
      params: { userId: 'u_01' },
      path: 'users/u_01/lifecycle',
      surface: { name: 'partner' },
    })
    expect(registry.resolve({
      method: 'GET',
      surface: 'partner',
      path: 'sites/s_01/indexing',
    }, { allow })).toBeNull()
  })

  it('builds canonical direct and proxy paths from operation IDs', () => {
    expect(registry.path('partner.users.lifecycle.get', { userId: 'u_01' }))
      .toBe('/api/partner/v1/users/u_01/lifecycle')
    expect(registry.path(
      'analytics.rows.query',
      { siteId: 's_01' },
      { apiRoot: '/api/_gscdump/' },
    )).toBe('/api/_gscdump/analytics/v1/sites/s_01/rows')
  })

  it('fails when callers retain stale operation IDs', () => {
    const stale = 'partner.sites.removed.get' as 'partner.users.lifecycle.get'

    expect(() => registry.operation(stale)).toThrow(/Unknown HTTP v1 operation ID/)
    expect(() => registry.path(stale)).toThrow(/Unknown HTTP v1 operation ID/)
    expect(() => registry.resolve({
      method: 'GET',
      surface: 'partner',
      path: 'users/u_01/lifecycle',
    }, { allow: [stale] })).toThrow(/Unknown HTTP v1 operation ID/)
  })
})
