import { describe, expect, it } from 'vitest'
import { agentOutcomeBodySchema, cliPapercutBodySchema, redactAgentFeedbackText } from '../src/agent-feedback'

describe('agent feedback boundary', () => {
  const report = { command: 'indexing watch list', comment: 'Agent report by Codex. Expected retained rows. Received a timeout.', agent: 'Codex', cliVersion: '7.12.0', node: '26.8.1', platform: 'linux' }

  it('preserves safe request correlation and declared product origin', () => {
    expect(cliPapercutBodySchema.parse({ ...report, requestId: 'req_01', parentRequestId: 'req_parent', workflowId: 'task_01', origin: 'requestindexing.com', product: 'requestindexing', surface: 'cli', operation: 'partner.sites.indexing.watched.list', skillDigest: 'a'.repeat(64) })).toMatchObject({ requestId: 'req_01', parentRequestId: 'req_parent', workflowId: 'task_01', origin: 'requestindexing.com', product: 'requestindexing', surface: 'cli' })
  })

  it.each([{ requestId: 'request\nforged' }, { origin: 'https://private.example/path?token=secret' }, { skillDigest: 'not-a-digest' }])('rejects unsafe correlation fields: %j', (context) => {
    expect(cliPapercutBodySchema.safeParse({ ...report, ...context }).success).toBe(false)
  })

  it('redacts known secrets and email before durable feedback storage', () => {
    const result = redactAgentFeedbackText('Authorization: Bearer abc.def.secret email agent@example.com key gsd_user_12345678901234567890123456789012 https://example.com/?token=secret&ok=1')
    expect(result).not.toContain('abc.def.secret')
    expect(result).not.toContain('agent@example.com')
    expect(result).not.toContain('gsd_user_12345678901234567890123456789012')
    expect(result).not.toContain('token=secret')
    expect(result).not.toContain('https://example.com/')
  })

  it('redacts cookie headers, Basic credentials and secret assignments', () => {
    const result = redactAgentFeedbackText('Basic YWJjOnNlY3JldA==\nCookie: session=abc; refresh=def\nCLOUDFLARE_API_TOKEN=secret123')
    expect(result).not.toContain('YWJjOnNlY3JldA==')
    expect(result).not.toContain('session=abc')
    expect(result).not.toContain('refresh=def')
    expect(result).not.toContain('secret123')
  })

  it('preserves simultaneous evidence limits on a declared outcome', () => {
    expect(agentOutcomeBodySchema.parse({ eventId: 'evt_01', workflowId: 'task_01', surface: 'cli', operation: 'indexing.summary', step: 'complete', outcome: 'success', semanticFlags: ['partial', 'stale', 'truncated'], quality: 'unknown' })).toMatchObject({ semanticFlags: ['partial', 'stale', 'truncated'], quality: 'unknown' })
  })

  it('refuses client-supplied verification and raw content', () => {
    const outcome = { eventId: 'evt_01', workflowId: 'task_01', surface: 'cli', operation: 'indexing.summary', step: 'complete', outcome: 'success' }
    expect(agentOutcomeBodySchema.safeParse({ ...outcome, evidenceClass: 'verified' }).success).toBe(false)
    expect(agentOutcomeBodySchema.safeParse({ ...outcome, prompt: 'customer content' }).success).toBe(false)
  })
})
