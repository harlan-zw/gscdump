/**
 * Why a command stopped. The packaged skill lists every code, so an agent can
 * act on it without reading the message.
 */
export type StopCode
  // Local routing: the Store or Google cannot answer the read.
  = | 'NOT_CONNECTED'
    | 'STORE_RANGE_NOT_COVERED'
    | 'SYNC_RUNNING'
    | 'NO_SYNCED_DATA'
    | 'STORE_ONLY'
    | 'LIVE_ONLY'
  // Access mode and Hosted credentials.
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
