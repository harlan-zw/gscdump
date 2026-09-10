import { describe, expect, it, vi } from 'vitest'
import { buildPapercutBody, resolvePapercutUrl, submitPapercut } from '../src/papercut'
import { VERSION } from '../src/utils'

function fakeFetch(response: { status: number, body?: unknown, headers?: Record<string, string> }) {
  const calls: Array<{ url: string, init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json', ...response.headers },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('buildPapercutBody', () => {
  it('stamps the CLI version, node, and platform onto a valid report', () => {
    const built = buildPapercutBody({ command: 'report triage', comment: 'Agent report by Codex. Expected x. Received y.', agent: 'Codex' })
    expect(built._tag).toBe('Ok')
    if (built._tag !== 'Ok')
      return
    expect(built.body).toMatchObject({ command: 'report triage', agent: 'Codex', intent: 'bug', cliVersion: VERSION })
    expect(built.body.node).toBe(process.versions.node)
    expect(built.body.platform).toBe(process.platform)
  })

  it('rejects a missing comment with the field name', () => {
    const built = buildPapercutBody({ command: 'sync', comment: undefined, agent: 'Codex' })
    expect(built).toMatchObject({ _tag: 'Err' })
    if (built._tag === 'Err')
      expect(built.message).toMatch(/^comment:/)
  })

  it('rejects an unknown intent', () => {
    const built = buildPapercutBody({ command: 'sync', comment: 'x', agent: 'Codex', intent: 'praise' })
    expect(built._tag).toBe('Err')
  })
})

describe('resolvePapercutUrl', () => {
  it('defaults to gscdump.com and honours GSCDUMP_API_URL without a doubled slash', () => {
    expect(resolvePapercutUrl({})).toBe('https://gscdump.com/api/cli/papercuts')
    expect(resolvePapercutUrl({ GSCDUMP_API_URL: 'http://localhost:3000/' })).toBe('http://localhost:3000/api/cli/papercuts')
  })
})

describe('submitPapercut', () => {
  const body = {
    command: 'report triage',
    comment: 'Agent report by Codex. Expected --target-kind in help.',
    agent: 'Codex',
    intent: 'bug' as const,
    cliVersion: '3.5.0',
    node: '22.0.0',
    platform: 'linux',
  }

  it('posts JSON once with the version header and returns the receipt', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: { id: 'fb_1', status: 'new' } })
    const result = await submitPapercut(body, { fetch: fetchImpl, url: 'https://gscdump.com/api/cli/papercuts' })
    expect(result).toEqual({ _tag: 'Ok', receipt: { id: 'fb_1', status: 'new' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(body)
    expect((calls[0]!.init.headers as Record<string, string>)['x-cli-version']).toBe('3.5.0')
  })

  it('maps 429 to rate_limited with the Retry-After hint', async () => {
    const { fetchImpl } = fakeFetch({ status: 429, headers: { 'retry-after': '900' } })
    const result = await submitPapercut(body, { fetch: fetchImpl, url: 'u' })
    expect(result).toMatchObject({ _tag: 'Err', reason: 'rate_limited' })
    if (result._tag === 'Err')
      expect(result.message).toContain('900s')
  })

  it('maps a network failure to unreachable and does not retry', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await submitPapercut(body, { fetch: fetchImpl, url: 'u' })
    expect(result).toMatchObject({ _tag: 'Err', reason: 'unreachable' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('treats a 200 without an id as rejected', async () => {
    const { fetchImpl } = fakeFetch({ status: 200, body: { ok: true } })
    const result = await submitPapercut(body, { fetch: fetchImpl, url: 'u' })
    expect(result).toMatchObject({ _tag: 'Err', reason: 'rejected' })
  })
})
