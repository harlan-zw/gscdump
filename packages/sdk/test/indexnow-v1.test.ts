import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const receipt = { _tag: 'queued', id: 'in_1', urls: ['https://example.com/page'], createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', attempts: 0, httpStatus: null, reason: null, retryAt: null }
describe('indexNow hosted client', () => {
  it('submits URLs and reads a receipt without leaking a key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: { submissionReceipt: receipt }, meta: { requestId: 'req_1', surface: 'partner', version: '1.0' } }), { status: 200 }))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })
    const result = await client.submitSiteIndexNow({ params: { siteId: 's_1' }, body: { urls: receipt.urls, idempotencyKey: 'request1' } })
    expect(result.data.submissionReceipt).toEqual(receipt)
    expect(fetch).toHaveBeenCalledWith('/api/_gscdump/partner/v1/sites/s_1/indexing/indexnow/submissions', expect.objectContaining({ method: 'POST', body: JSON.stringify({ urls: receipt.urls, idempotencyKey: 'request1' }) }))
  })
  it('rejects an oversized batch before transport', async () => {
    const fetch = vi.fn()
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })
    await expect(client.submitSiteIndexNow({ params: { siteId: 's_1' }, body: { urls: Array.from({ length: 1001 }, () => receipt.urls[0]!), idempotencyKey: 'request1' } })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
