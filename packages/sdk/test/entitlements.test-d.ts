import type { SiteHoldReason, UserAllowanceNoticeData, WebhookEnvelope } from '@gscdump/contracts'
import type { GscdumpV1OperationResponse } from '../src/v1/http'
import { describe, expectTypeOf, it } from 'vitest'
import { parseWebhookPayload } from '../src/webhook'

describe('parseWebhookPayload', () => {
  it('narrows data by event', async () => {
    const envelope = await parseWebhookPayload('{}')
    if (envelope.event === 'user.allowance.notice')
      expectTypeOf(envelope.data).toEqualTypeOf<UserAllowanceNoticeData>()
  })

  it('stays assignable to the untyped envelope', async () => {
    expectTypeOf(await parseWebhookPayload('{}')).toExtend<WebhookEnvelope>()
  })

  it('keeps the explicit data type argument', async () => {
    expectTypeOf(await parseWebhookPayload<{ transition: string }>('{}')).toEqualTypeOf<WebhookEnvelope<{ transition: string }>>()
  })
})

describe('entitlement response types', () => {
  it('reads as a hold reason or null on each lifecycle Site', () => {
    type LifecycleSite = GscdumpV1OperationResponse<'partner.users.lifecycle.get'>['data']['sites'][number]
    expectTypeOf<LifecycleSite['hold']>().toEqualTypeOf<SiteHoldReason | null>()
  })

  it('carries Meters only on a metered response', () => {
    type Entitlements = GscdumpV1OperationResponse<'partner.users.entitlements.get'>['data']
    expectTypeOf<Extract<Entitlements, { mode: 'metered' }>['meters']['urlInspections']['allowance']>().toEqualTypeOf<number | null>()
    expectTypeOf<Extract<Entitlements, { mode: 'exempt' }>>().not.toHaveProperty('meters')
  })
})
