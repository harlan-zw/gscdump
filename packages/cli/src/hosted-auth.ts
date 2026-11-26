import type { StopDetails } from './stop'
import { z } from 'zod'
import { userStopError } from './stop'

const ORIGIN = 'https://gscdump.com'
const MAX_TRANSIENT_POLL_FAILURES = 5
const BASE_POLL_INTERVAL_MS = 2000
const MAX_POLL_BACKOFF_MS = 8000

const pollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('complete'), sessionId: z.string().regex(/^[a-f0-9]{64}$/) }),
])

const HOSTED_LOGIN_FAILURE = 'Hosted login failed. Run `gscdump auth login --mode hosted` to try again.'
const HOSTED_LOGIN_UNAVAILABLE = 'gscdump.com login is temporarily unavailable. Try again later.'

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

class TransientHostedLoginError extends Error {
  constructor(message: string = HOSTED_LOGIN_UNAVAILABLE) {
    super(message)
    this.name = 'TransientHostedLoginError'
  }
}

function isTransientNetworkError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException
}

async function requestJson(request: typeof fetch, route: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response
  try {
    response = await request(`${ORIGIN}/api/cli/auth/${route}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
  }
  catch (error: unknown) {
    if (isTransientNetworkError(error))
      throw new TransientHostedLoginError()
    throw error
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500)
      throw new TransientHostedLoginError()
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
  userAgent?: string
}): Promise<string> {
  // `mode=cloud` is a wire constant. gscdump.com releases before the Hosted
  // rename need it to issue a session code; newer releases ignore it.
  const init = z.object({
    code: z.string().regex(/^S-[A-F0-9]{20}$/),
    expiresIn: z.number().int().positive().max(600),
  }).parse(await requestJson(deps.request, 'init?mode=cloud', { method: 'POST' }))
  const deadline = deps.now() + init.expiresIn * 1000
  const pollParams = new URLSearchParams({ code: init.code })
  if (deps.userAgent?.trim())
    pollParams.set('userAgent', deps.userAgent.trim())
  const pollRoute = `poll?${pollParams.toString()}`
  // Ignore response URLs. Only the fixed origin opens in a browser.
  await deps.authorize(`${ORIGIN}/app/cli/auth?code=${init.code}`)
  let transientFailures = 0
  while (deps.now() < deadline) {
    let payload: unknown
    try {
      payload = await requestJson(deps.request, pollRoute)
      transientFailures = 0
    }
    catch (error: unknown) {
      if (!(error instanceof TransientHostedLoginError))
        throw error
      transientFailures++
      if (transientFailures >= MAX_TRANSIENT_POLL_FAILURES)
        throw new Error(HOSTED_LOGIN_UNAVAILABLE)
      const backoff = Math.min(BASE_POLL_INTERVAL_MS * (transientFailures + 1), MAX_POLL_BACKOFF_MS)
      await deps.wait(backoff)
      continue
    }
    const result = pollSchema.parse(payload)
    if (result.status === 'complete')
      return result.sessionId
    await deps.wait(BASE_POLL_INTERVAL_MS)
  }
  throw new Error('Authorization expired. Run `gscdump auth login --mode hosted` to try again.')
}
