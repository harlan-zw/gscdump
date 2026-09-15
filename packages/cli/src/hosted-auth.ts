import { z } from 'zod'

const ORIGIN = 'https://gscdump.com'
const accessSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
})
const pollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('complete'), tokens: accessSchema.extend({ refreshToken: z.string().min(1) }) }),
])

export interface PlatformTokens {
  provider: 'gscdump'
  access_token: string
  refresh_token: string
  expiry_date: number
}

async function requestJson(request: typeof fetch, route: string, init: RequestInit = {}): Promise<unknown> {
  const response = await request(`${ORIGIN}/api/cli/auth/${route}`, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new Error('Google authorization failed. Run `gscdump auth login` to reconnect.')
  return response.json()
}

export async function refreshWithPlatform(refreshToken: string, request: typeof fetch = fetch): Promise<{ access_token: string, expiry_date: number }> {
  const result = accessSchema.parse(await requestJson(request, 'refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  }))
  return { access_token: result.accessToken, expiry_date: result.expiresAt }
}

export async function loginWithPlatform(deps: {
  request: typeof fetch
  authorize: (url: string) => Promise<void>
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}): Promise<PlatformTokens> {
  const init = z.object({
    code: z.string().regex(/^[A-F0-9]{20}$/),
    expiresIn: z.number().int().positive().max(600),
  }).parse(await requestJson(deps.request, 'init', { method: 'POST' }))
  const deadline = deps.now() + init.expiresIn * 1000
  // Ignore response URLs. Only the fixed platform receives credentials or opens in a browser.
  await deps.authorize(`${ORIGIN}/app/cli/auth?code=${init.code}`)
  while (deps.now() < deadline) {
    const result = pollSchema.parse(await requestJson(deps.request, `poll?code=${init.code}`))
    if (result.status === 'complete') {
      return {
        provider: 'gscdump',
        access_token: result.tokens.accessToken,
        refresh_token: result.tokens.refreshToken,
        expiry_date: result.tokens.expiresAt,
      }
    }
    await deps.wait(2000)
  }
  throw new Error('Authorization expired. Run `gscdump auth login` to try again.')
}
