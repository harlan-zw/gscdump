import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

describe('agent telemetry contracts through SDK transport', () => {
  it('sends correlation without treating declared product as a credential', async () => {
    let sent: Headers | undefined
    let url: string | undefined
    const request = vi.fn<typeof fetch>(async (input, init) => {
      url = String(input)
      sent = new Headers(init?.headers)
      return Response.json({ data: { measuredAt: '2026-11-10T00:00:00.000Z', activities: [] }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } })
    })
    const client = createGscdumpV1Client({ credential: 'partner_secret', fetch: request, requestContext: { product: 'requestindexing', workflowId: 'task_01', parentRequestId: 'req_parent', cliVersion: '7.12.0', skillDigest: 'a'.repeat(64), client: 'gscdump-cli' } })
    const response = await client.getUserIntegrationActivity({ params: { userId: 'u_01' } })
    expect(response.data.activities).toEqual([])
    expect(url).toBe('https://gscdump.com/api/partner/v1/users/u_01/integration-activity')
    expect(sent?.get('authorization')).toBe('Bearer partner_secret')
    expect(sent?.get('x-workflow-id')).toBe('task_01')
    expect(sent?.get('x-parent-request-id')).toBe('req_parent')
    expect(sent?.get('x-gscdump-product')).toBe('requestindexing')
    expect(sent?.get('x-gscdump-skill-digest')).toBe('a'.repeat(64))
  })

  it('rejects unsafe correlation before making a request', async () => {
    const request = vi.fn<typeof fetch>()
    const client = createGscdumpV1Client({ credential: 'partner_secret', fetch: request, requestContext: { workflowId: 'unsafe\ninjected-header' } })
    await expect(client.getUserIntegrationActivity({ params: { userId: 'u_01' } })).rejects.toMatchObject({ code: 'request_validation' })
    expect(request).not.toHaveBeenCalled()
  })
})
