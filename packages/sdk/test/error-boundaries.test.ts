import { describe, expect, it } from 'vitest'
import { createPartnerClient } from '../src/client'
import { PartnerApiError, toPartnerError } from '../src/errors'

describe('hosted error boundaries', () => {
  it.each([undefined, null])('normalizes an empty rejection reason %s', (cause) => {
    const error = toPartnerError(cause)
    expect(error).toBeInstanceOf(PartnerApiError)
    expect(error).toMatchObject({ kind: 'network', message: String(cause) })
  })

  it('classifies response schema failures as validation errors', async () => {
    const client = createPartnerClient({ validate: 'response', fetch: (async () => ({})) as never })
    await expect(client.getUserSites('u_1')).rejects.toMatchObject({
      kind: 'validation',
      data: { issues: [expect.objectContaining({ path: ['sites'] })] },
    })
  })
})
