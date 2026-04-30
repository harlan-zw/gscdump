import process from 'node:process'
import { formatErrorForCli } from 'gscdump'
import { formatAuthProvenance, isAuthError } from './auth'

/**
 * .catch() handler for GSC API errors — prints a formatted message and exits 1.
 * Use: somePromise.catch(gscErrorHandler)
 *
 * On auth-shaped errors (401, invalid_grant, etc.) we append a provenance
 * dump so the user can see *which* config source supplied the broken
 * credential — the most common cause is a stale `.env` shadowing fresh
 * saved tokens.
 */
export async function gscErrorHandler(error: unknown): Promise<never> {
  console.error()
  console.error(formatErrorForCli(error))
  if (isAuthError(error)) {
    console.error()
    console.error(await formatAuthProvenance())
  }
  console.error()
  process.exit(1)
}
