import type { CanonicalWebhookEventType } from './types'

export const WEBHOOK_CONTRACT_VERSION = '2026-05-11'

export const WEBHOOK_SIGNATURE_HEADER = 'X-GSCDump-Signature'
export const WEBHOOK_EVENT_HEADER = 'X-GSCDump-Event'
export const WEBHOOK_DELIVERY_HEADER = 'X-GSCDump-Delivery'
export const WEBHOOK_CONTRACT_VERSION_HEADER = 'X-GSCDump-Contract-Version'
export const WEBHOOK_TIMESTAMP_HEADER = 'X-GSCDump-Timestamp'

export const CANONICAL_WEBHOOK_EVENTS = [
  'user.lifecycle.changed',
  'site.lifecycle.changed',
  'site.analytics.ready',
  'site.indexing.ready',
  'site.auth.failed',
  'job.failed',
] as const satisfies readonly CanonicalWebhookEventType[]

export const VALID_WEBHOOK_EVENTS = CANONICAL_WEBHOOK_EVENTS
