import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const receipt = { _tag: 'queued', id: 'in_1', trigger: 'manual', urls: ['https://example.com/page'], createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', attempts: 0, httpStatus: null, reason: null, retryAt: null }
const meta = { requestId: 'req_1', surface: 'partner', version: '1.0' }
describe('indexNow hosted client', () => {
  it('submits URLs and reads a receipt without leaking a key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: { submissionReceipt: receipt }, meta }), { status: 200 }))
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
  it('turns automatic sending on and reads the connection back', async () => {
    const connection = { _tag: 'connected', host: 'example.com', keyLocation: 'https://example.com/abc12345.txt', verifiedAt: '2026-09-30T00:00:00.000Z', automaticSending: { _tag: 'on', since: '2026-11-18T00:00:00.000Z', lastCheck: null } }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: connection, meta }), { status: 200 }))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })
    const result = await client.updateSiteIndexNowAutomaticSending({ params: { siteId: 's_1' }, body: { automaticSending: 'on' } })
    expect(result.data).toEqual(connection)
    expect(fetch).toHaveBeenCalledWith('/api/_gscdump/partner/v1/sites/s_1/indexing/indexnow/automatic-sending', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ automaticSending: 'on' }) }))
  })
  it('reads an older host receipt list as manual Submissions', async () => {
    const { trigger: _trigger, ...older } = receipt
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: { submissionReceipts: [older], pagination: { total: 1, limit: 25, offset: 0, hasMore: false } }, meta }), { status: 200 }))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })
    const result = await client.listSiteIndexNowSubmissionReceipts({ params: { siteId: 's_1' }, query: { limit: 25, offset: 0 } })
    expect(result.data.submissionReceipts[0]?.trigger).toBe('manual')
  })
})

describe('submission reads', () => {
  it('requests the summary window and returns the counts', async () => {
    const summary = { window: { days: 7, from: '2026-11-11T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z' }, indexNow: { submissions: 0, urls: 0, urlsByState: { queued: 0, accepted: 0, pending: 0, rejected: 0, retrying: 0, failed: 0 }, urlsByTrigger: { manual: 0, automatic: 0 } }, google: { submissions: 0, byState: { accepted: 0, rejected: 0, failed: 0 } } }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: summary, meta }), { status: 200 }))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })
    const result = await client.getSiteSubmissionSummary({ params: { siteId: 's_1' }, query: { days: 7 } })
    expect(result.data).toEqual(summary)
    expect(String(fetch.mock.calls[0]?.[0])).toBe('/api/_gscdump/partner/v1/sites/s_1/indexing/submissions/summary?days=7')
  })

  it('sends receipt filters as query parameters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: { submissionReceipts: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } }, meta }), { status: 200 }))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })
    await client.listSiteIndexNowSubmissionReceipts({ params: { siteId: 's_1' }, query: { limit: 25, offset: 0, trigger: 'automatic', state: 'accepted' } })
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'https://host.test')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ trigger: 'automatic', state: 'accepted' })
  })
})
