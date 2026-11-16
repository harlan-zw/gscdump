import { describe, expect, it } from 'vitest'
import { hostedRequestContext } from '../src/hosted-context'

describe('hosted skill invocation context', () => {
  it('sends skill identity only when explicitly supplied for the command', () => {
    expect(hostedRequestContext({ GSCDUMP_SKILL_NAME: 'gscdump', GSCDUMP_SKILL_VERSION: '7.13.2' })).toMatchObject({ skillName: 'gscdump', skillVersion: '7.13.2', client: 'gscdump-cli' })
    const ordinary = hostedRequestContext({})
    expect(ordinary.skillName).toBeUndefined()
    expect(ordinary.skillVersion).toBeUndefined()
  })

  it('refuses an incomplete explicit context before a request', () => {
    expect(() => hostedRequestContext({ GSCDUMP_SKILL_NAME: 'gscdump' })).toThrow()
  })
})
