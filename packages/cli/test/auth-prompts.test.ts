import type * as ClackPrompts from '@clack/prompts'
import process from 'node:process'
import { CANCEL_SYMBOL, text } from '@clack/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthCredentials } from '../src/auth'

vi.mock('@clack/prompts', async importOriginal => ({
  ...await importOriginal<typeof ClackPrompts>(),
  text: vi.fn(),
}))
vi.mock('../src/config', () => ({ loadConfig: async () => ({}) }))
vi.mock('../src/environment', () => ({ resolveCliEnvironment: () => ({}) }))

describe('oAuth credential prompts', () => {
  beforeEach(() => {
    vi.mocked(text).mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit requested')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns both entered credentials', async () => {
    vi.mocked(text).mockResolvedValueOnce('client-id').mockResolvedValueOnce('client-secret')

    expect(await getAuthCredentials(true)).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' })
  })

  it.each([CANCEL_SYMBOL, Symbol('cancel')])('exits when the client ID prompt returns %s', async (cancel) => {
    vi.mocked(text).mockResolvedValueOnce(cancel)

    await expect(getAuthCredentials(true)).rejects.toThrow('exit requested')
    expect(text).toHaveBeenCalledTimes(1)
    expect(process.exit).toHaveBeenCalledWith(1)
  })

  it('exits when the client secret prompt is cancelled', async () => {
    vi.mocked(text).mockResolvedValueOnce('client-id').mockResolvedValueOnce(CANCEL_SYMBOL)

    await expect(getAuthCredentials(true)).rejects.toThrow('exit requested')
    expect(process.exit).toHaveBeenCalledWith(1)
  })
})
