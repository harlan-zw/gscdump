// Wire shapes for a hosted read the Site's record cannot serve.
import { z } from 'zod'

/**
 * The `details.reason` values of a v1 error envelope that refuses a read
 * because the Site's record cannot serve it. The host never answers such a
 * read from live Google, and never answers it with an empty `200`.
 */
export const RECORD_READ_REFUSAL_REASONS = [
  'record_not_ready',
  'range_not_synced',
] as const

export type RecordReadRefusalReason = typeof RECORD_READ_REFUSAL_REASONS[number]

/** The Site's own sync state, sent when the host has it. */
const siteSyncFields = {
  syncStatus: z.string().min(1).optional(),
  lastSyncAt: z.number().int().nonnegative().optional(),
  oldestDateSynced: z.iso.date().optional(),
  newestDateSynced: z.iso.date().optional(),
}

/**
 * The `details` of a v1 error envelope that refuses a read of the Site's
 * record. Both are 409 `invalid_request`, and an immediate retry gets the same
 * answer.
 *
 * - `record_not_ready`: the Site has no synced data, or its Team catalog does
 *   not serve reads yet.
 * - `range_not_synced`: Sync has not reached the days from `missingStart` to
 *   `missingEnd` (`YYYY-MM-DD`), which Google still serves.
 *
 * Both can carry the Site's `syncStatus`, `lastSyncAt` (Unix seconds),
 * `oldestDateSynced`, and `newestDateSynced`. Unknown `details` keys are
 * dropped, so a newer host can add keys.
 */
export const recordReadRefusalSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('record_not_ready'), ...siteSyncFields }),
  z.object({ reason: z.literal('range_not_synced'), missingStart: z.iso.date(), missingEnd: z.iso.date(), ...siteSyncFields }),
])

export type RecordReadRefusal = z.infer<typeof recordReadRefusalSchema>

/**
 * Read a record read refusal from the `details` of a v1 error envelope, such
 * as `GscdumpV1Error.details`. Returns `null` when the details describe a
 * different failure, or a refusal this contract version does not know.
 */
export function parseRecordReadRefusal(details: unknown): RecordReadRefusal | null {
  const parsed = recordReadRefusalSchema.safeParse(details)
  return parsed.success ? parsed.data : null
}
