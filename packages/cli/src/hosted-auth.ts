import type { StopDetails } from './stop'
import { z } from 'zod'
import { userStopError } from './stop'

const ORIGIN = 'https://gscdump.com'
const pollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('complete'), sessionId: z.string().regex(/^[a-f0-9]{64}$/) }),
])

const HOSTED_LOGIN_FAILURE = 'Hosted login failed. Run `gscdump auth login --mode hosted` to try again.'

export const LOGIN_CANCELLED: StopDetails = {
  code: 'LOGIN_CANCELLED',
  message: 'Login cancelled in the browser.',
  nextCommand: 'gscdump auth login --mode hosted',
}

/**
 * Cancel in the browser makes gscdump.com answer the poll with 403 and
 * `details.reason: 'login_cancelled'` in the h3 body. The reason is the
 * contract. The message is not.
 */
const loginCancelledBodySchema = z.object({ data: z.object({ details: z.object({ reason: z.literal('login_cancelled') }) }) })

async function requestJson(request: typeof fetch, route: string, init: RequestInit = {}): Promise<unknown> {
  const response = await request(`${ORIGIN}/api/cli/auth/${route}`, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500)
      throw new Error('gscdump.com login is temporarily unavailable. Try again later.')
    // A 403 body that is not JSON names no reason. It stays a failed login.
    if (response.status === 403 && loginCancelledBodySchema.safeParse(await response.json().catch(() => null)).success)
      throw userStopError(LOGIN_CANCELLED)
    throw new Error(HOSTED_LOGIN_FAILURE)
  }
  return response.json()
}

/**
 * Link the CLI to a gscdump.com account in the browser. The result is a CLI
 * session for Hosted mode. No Google token reaches the CLI.
 */
export async function loginWithHostedSession(deps: {
  request: typeof fetch
  authorize: (url: string) => Promise<void>
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}): Promise<string> {
  // `mode=cloud` is a wire constant. gscdump.com releases before the Hosted
  // rename need it to issue a session code; newer releases ignore it.
  const init = z.object({
    code: z.string().regex(/^S-[A-F0-9]{20}$/),
    expiresIn: z.number().int().positive().max(600),
  }).parse(await requestJson(deps.request, 'init?mode=cloud', { method: 'POST' }))
  const deadline = deps.now() + init.expiresIn * 1000
  // Ignore response URLs. Only the fixed origin opens in a browser.
  await deps.authorize(`${ORIGIN}/app/cli/auth?code=${init.code}`)
  while (deps.now() < deadline) {
    const result = pollSchema.parse(await requestJson(deps.request, `poll?code=${init.code}`))
    if (result.status === 'complete')
      return result.sessionId
    await deps.wait(2000)
  }
  throw new Error('Authorization expired. Run `gscdump auth login --mode hosted` to try again.')
}
