import type { StopDetails } from './stop'
import { z } from 'zod'

/**
 * gscdump.com ends a CLI session 90 days after the browser login. It refuses an
 * expired session with HTTP 401 and `details.reason: 'session_expired'`: in the
 * h3 body of `/api/cli/*` (`data.details`) and in the v1 error envelope
 * (`error.details`). The reason is the contract. The message is not.
 */
const sessionExpiredDetailsSchema = z.object({ reason: z.literal('session_expired') })
const sessionExpiredBodySchema = z.union([
  z.object({ data: z.object({ details: sessionExpiredDetailsSchema }) }),
  z.object({ error: z.object({ details: sessionExpiredDetailsSchema }) }),
])

export const HOSTED_SESSION_EXPIRED: StopDetails = {
  code: 'HOSTED_CREDENTIALS_REJECTED',
  message: 'Your gscdump.com session expired. Run `gscdump auth login --mode hosted`.',
  nextCommand: 'gscdump auth login --mode hosted',
}

/** The 401 body of a `/api/cli/*` route or a v1 operation says the CLI session expired. */
export function isSessionExpiredBody(body: unknown): boolean {
  return sessionExpiredBodySchema.safeParse(body).success
}

/**
 * A `GscdumpV1Error` for an expired CLI session. Matched by name, not
 * `instanceof`, so the error handler does not load the SDK on every run.
 */
export function isSessionExpiredError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'GscdumpV1Error')
    return false
  const { status, details } = error as { status?: unknown, details?: unknown }
  return status === 401 && sessionExpiredDetailsSchema.safeParse(details).success
}
