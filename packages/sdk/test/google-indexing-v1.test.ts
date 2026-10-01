import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const meta = { requestId: 'req_1', surface: 'partner', version: '1.0' }
const receipt = { _tag: 'accepted', id: 'gi_1', url: 'https://example.com/jobs/1', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', attempts: 1, httpStatus: 200, reason: null }
function client(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: body, meta }), { status: 200 }))
  return { fetch, client: createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch }) }
}

describe('google Indexing API hosted client', () => {
  it('submits one URL and returns its Submission Receipt', async () => {
    const { fetch, client: sdk } = client({ submissionReceipt: receipt })
    const result = await sdk.createSiteGoogleSubmission({ params: { siteId: 's_1' }, body: { url: receipt.url, idempotencyKey: 'request1' } })
    expect(result.data.submissionReceipt).toEqual(receipt)
    expect(fetch).toHaveBeenCalledWith('/api/_gscdump/partner/v1/sites/s_1/indexing/google/submissions', expect.objectContaining({ method: 'POST', body: JSON.stringify({ url: receipt.url, idempotencyKey: 'request1' }) }))
  })
  it('hands a grant over with PATCH and reads the stored state back', async () => {
    const grant = { _tag: 'granted', googleEmail: 'owner@example.com', grantedAt: '2026-10-01T00:00:00.000Z' }
    const { fetch, client: sdk } = client(grant)
    const result = await sdk.updateUserIndexingApiGrant({ params: { userId: 'u_1' }, body: { refreshToken: 'refresh', scope: 'https://www.googleapis.com/auth/indexing', googleEmail: 'owner@example.com' } })
    expect(result.data).toEqual(grant)
    expect(fetch).toHaveBeenCalledWith('/api/_gscdump/partner/v1/users/u_1/indexing/google/grant', expect.objectContaining({ method: 'PATCH' }))
  })
  it('refuses a batch before transport', async () => {
    const { fetch, client: sdk } = client({ submissionReceipt: receipt })
    // @ts-expect-error the protocol takes one URL per Submission
    await expect(sdk.createSiteGoogleSubmission({ params: { siteId: 's_1' }, body: { urls: [receipt.url], idempotencyKey: 'request1' } })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
