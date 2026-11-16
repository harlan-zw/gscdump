import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

describe('agent telemetry contracts through SDK transport', () => {
  it('preserves the qualified journey and reported skill counts from the engine', async () => {
    const agentJourney = { signedUpAt: '2026-11-01T00:00:00.000Z', configuredAt: null, firstSuccessfulAt: '2026-11-02T00:00:00.000Z', lastSuccessfulAt: '2026-11-04T00:00:00.000Z', returnedAt: '2026-11-04T00:00:00.000Z', successfulCalls: 3, observedSince: '2026-11-02T00:00:00.000Z', coverage: 'retained', returnAfterSeconds: 86400, returnBasis: 'last_observed_success' }
    const skills = [{ surface: 'cli', client: 'gscdump-cli', name: 'gscdump', version: '7.13.2', successfulUsers: 1, successfulCalls: 3, firstObservedAt: '2026-11-02T00:00:00.000Z', lastObservedAt: '2026-11-04T00:00:00.000Z', note: 'Caller-reported skill context.' }]
    const client = createGscdumpV1Client({ credential: 'partner_secret', fetch: async () => Response.json({ data: { measuredAt: '2026-11-10T00:00:00.000Z', activities: [], agentJourney, skills }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } }) })
    const response = await client.getUserIntegrationActivity({ params: { userId: 'u_01' } })
    expect(response.data.agentJourney).toEqual(agentJourney)
    expect(response.data.skills).toEqual(skills)
  })

  it('sends correlation without treating declared product as a credential', async () => {
    let sent: Headers | undefined
    let url: string | undefined
    const request = vi.fn<typeof fetch>(async (input, init) => {
      url = String(input)
      sent = new Headers(init?.headers)
      return Response.json({ data: { measuredAt: '2026-11-10T00:00:00.000Z', activities: [] }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } })
    })
    const client = createGscdumpV1Client({ credential: 'partner_secret', fetch: request, requestContext: { product: 'requestindexing', workflowId: 'task_01', parentRequestId: 'req_parent', cliVersion: '7.12.0', skillDigest: 'a'.repeat(64), skillName: 'gscdump', skillVersion: '7.13.2', client: 'gscdump-cli' } })
    const response = await client.getUserIntegrationActivity({ params: { userId: 'u_01' } })
    expect(response.data.activities).toEqual([])
    expect(url).toBe('https://gscdump.com/api/partner/v1/users/u_01/integration-activity')
    expect(sent?.get('authorization')).toBe('Bearer partner_secret')
    expect(sent?.get('x-workflow-id')).toBe('task_01')
    expect(sent?.get('x-parent-request-id')).toBe('req_parent')
    expect(sent?.get('x-gscdump-product')).toBe('requestindexing')
    expect(sent?.get('x-gscdump-skill-digest')).toBe('a'.repeat(64))
    expect(sent?.get('x-gscdump-skill-name')).toBe('gscdump')
    expect(sent?.get('x-gscdump-skill-version')).toBe('7.13.2')
  })

  it('rejects unsafe correlation before making a request', async () => {
    const request = vi.fn<typeof fetch>()
    const client = createGscdumpV1Client({ credential: 'partner_secret', fetch: request, requestContext: { workflowId: 'unsafe\ninjected-header' } })
    await expect(client.getUserIntegrationActivity({ params: { userId: 'u_01' } })).rejects.toMatchObject({ code: 'request_validation' })
    expect(request).not.toHaveBeenCalled()
  })
})
