import type { SiteVersionIdentityResponse } from '@gscdump/contracts/partner'
import type { GscdumpV1OperationResponse } from '../src/v1/http'
import { describe, expectTypeOf, it } from 'vitest'

describe('lifecycle Site registration type', () => {
  it('reads as the identity operation answer, or absent', () => {
    type LifecycleSite = GscdumpV1OperationResponse<'partner.users.lifecycle.get'>['data']['sites'][number]
    type Identity = GscdumpV1OperationResponse<'partner.sites.registered_host.identity.get'>['data']
    expectTypeOf<LifecycleSite['registration']>().toEqualTypeOf<SiteVersionIdentityResponse | undefined>()
    expectTypeOf<NonNullable<LifecycleSite['registration']>>().toEqualTypeOf<Identity>()
  })
})
