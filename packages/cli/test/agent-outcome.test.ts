import { describe, expect, it, vi } from 'vitest'
import { submitAgentOutcome } from '../src/agent-outcome'

const body = { eventId: 'evt_01', workflowId: 'task_01', product: 'gscdump', surface: 'cli' as const, operation: 'indexing.summary', step: 'complete' as const, outcome: 'success' as const, semanticFlags: [], quality: 'unknown' as const }

describe('explicit agent outcomes', () => {
  it('submits only bounded metadata and accepts a declared receipt', async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(body)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer saved-session')
      return Response.json({ id: 'outcome_01', evidenceClass: 'declared', duplicate: false })
    })
    await expect(submitAgentOutcome(body, { fetch: request, url: 'https://gscdump.com/api/cli/agent-outcomes', credential: 'saved-session' })).resolves.toEqual({ _tag: 'Ok', receipt: { id: 'outcome_01', evidenceClass: 'declared', duplicate: false } })
  })

  it('never retries an uncertain write', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('response lost')
    })
    await expect(submitAgentOutcome(body, { fetch: request, url: 'https://gscdump.com/api/cli/agent-outcomes' })).resolves.toMatchObject({ _tag: 'Err', reason: 'unreachable' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects a receipt that claims engine verification', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ id: 'outcome_01', evidenceClass: 'verified', duplicate: false }))
    await expect(submitAgentOutcome(body, { fetch: request, url: 'https://gscdump.com/api/cli/agent-outcomes' })).resolves.toMatchObject({ _tag: 'Err', reason: 'rejected' })
  })
})
