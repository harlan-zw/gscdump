import process from 'node:process'
import { formatErrorForCli } from 'gscdump'
import { formatAuthProvenance, isAuthError } from './auth'

/**
 * Thrown by `resolveAnalysisSource`'s `runAnalysis` closure when the
 * dispatcher reports `AnalyzerCapabilityError`. Carries `mode` so the
 * top-level handler can render the right "next step" hint.
 */
export class LocalStoreUnsupportedError extends Error {
  readonly tool: string
  readonly mode: 'live' | 'local'
  constructor(tool: string, mode: 'live' | 'local') {
    super(`analysis "${tool}" has no implementation for the ${mode} source`)
    this.name = 'LocalStoreUnsupportedError'
    this.tool = tool
    this.mode = mode
  }
}

/**
 * .catch() handler for CLI errors — prints a formatted message and exits 1.
 * Use: somePromise.catch(gscErrorHandler)
 *
 * On auth-shaped errors (401, invalid_grant, etc.) we append a provenance
 * dump so the user can see *which* config source supplied the broken
 * credential — the most common cause is a stale `.env` shadowing fresh
 * saved tokens.
 */
export async function gscErrorHandler(error: unknown): Promise<never> {
  console.error()
  if (error instanceof LocalStoreUnsupportedError) {
    console.error(formatErrorForCli(error))
    if (error.mode === 'local')
      console.error('Pass --live to run against the GSC API.')
    console.error()
    process.exit(1)
  }
  console.error(formatErrorForCli(error))
  if (isAuthError(error)) {
    console.error()
    console.error(await formatAuthProvenance())
  }
  console.error()
  process.exit(1)
}
