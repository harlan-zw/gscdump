import { describe, expect, it } from 'vitest'
import { checkPublishAgent } from '../scripts/publish-agent'

describe('checkPublishAgent', () => {
  it('allows pnpm, which resolves workspace and catalog versions', () => {
    expect(checkPublishAgent('pnpm/12.4.2 npm/? node/? linux x64')).toEqual({ _tag: 'Allowed' })
  })

  it.each([
    ['npm', 'npm/12.0.2 node/v24.18.0 linux x64 workspaces/false'],
    ['yarn', 'yarn/4.5.0 npm/? node/v24.18.0 linux x64'],
    ['an unknown tool', undefined],
  ])('refuses %s, which would publish raw workspace and catalog versions', (_, agent) => {
    expect(checkPublishAgent(agent)._tag).toBe('Refused')
  })
})
