/**
 * Why a command stopped. The packaged skill lists every code, so an agent can
 * act on it without reading the message.
 */
export type StopCode
  // The command line is wrong: an unknown command or option, or a value the option does not accept.
  = | 'USAGE'
  // Local routing: the Store or Google cannot answer the read.
    | 'NOT_CONNECTED'
    | 'STORE_RANGE_NOT_COVERED'
    | 'SYNC_RUNNING'
    | 'NO_SYNCED_DATA'
    | 'STORE_ONLY'
    | 'LIVE_ONLY'
  // Access mode and Hosted credentials.
    | 'LOGIN_CANCELLED'
    | 'LOCAL_MODE_REQUIRED'
    | 'HOSTED_MODE_REQUIRED'
    | 'HOSTED_CREDENTIALS_MISSING'
    | 'HOSTED_CREDENTIALS_REJECTED'
  // Hosted Site resolution.
    | 'NO_SITES'
    | 'SITE_NOT_FOUND'
    | 'SITE_AMBIGUOUS'
    | 'SITE_REQUIRED'
    | 'BING_NOT_CONNECTED'
  // The hosted record cannot serve the read.
    | 'RECORD_NOT_READY'
    | 'RANGE_NOT_SYNCED'
  // A Google API quota is used up until its reset time.
    | 'QUOTA_USED_UP'

/**
 * The `code` of a JSON error. A stop has its own code. Every other failure has
 * one of two: `FAILED` (an expected failure, such as a network or API error) or
 * `UNEXPECTED` (a defect in the CLI).
 */
export type ErrorCode = StopCode | 'FAILED' | 'UNEXPECTED'

/** What a command that writes JSON prints on stdout as `{ error }` when it fails. */
export interface JsonError {
  code: ErrorCode
  message: string
  nextCommand: string | null
}

/**
 * A stop: a known condition that ends a command, with the next step. When the
 * command writes JSON, the shell prints `{ error: StopDetails }` on stdout.
 * `nextCommand` is null when no command fixes the condition.
 */
export interface StopDetails {
  code: StopCode
  message: string
  nextCommand: string | null
}

export type StopError<T extends StopDetails = StopDetails> = Error & { stopDetails: T }

/** End a command at a stop. The shell prints the message, and the JSON form under JSON output. */
export function stopError<T extends StopDetails>(details: T, name = 'StopError'): StopError<T> {
  return Object.assign(new Error(details.message), { name, stopDetails: details })
}

/** The stop a thrown value carries, if any. */
export function stopDetailsOf(error: unknown): StopDetails | undefined {
  return error instanceof Error ? (error as Partial<StopError>).stopDetails : undefined
}

/**
 * A stop the user chose, such as Cancel in the browser. The shell prints its
 * message as a plain line, not as an `Error:` line, and still exits 1.
 */
export function userStopError<T extends StopDetails>(details: T): StopError<T> & { userStop: true } {
  return Object.assign(stopError(details, 'UserStopError'), { userStop: true as const })
}

export function isUserStop(error: unknown): boolean {
  return error instanceof Error && (error as { userStop?: unknown }).userStop === true
}

/** A command line the command cannot run, such as `--limit 0`. The stop code is `USAGE`. */
export function commandLineError(message: string): StopError {
  return stopError({ code: 'USAGE', message, nextCommand: null })
}
