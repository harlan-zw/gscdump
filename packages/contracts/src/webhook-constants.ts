import type { CanonicalWebhookEventType, WebhookEventType } from './types'

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

export const LEGACY_WEBHOOK_EVENTS = [
  'job.completed',
  'job.failed',
  'site.completed',
  'indexing.completed',
  'auth.failed',
] as const

export const VALID_WEBHOOK_EVENTS = [
  ...LEGACY_WEBHOOK_EVENTS,
  ...CANONICAL_WEBHOOK_EVENTS.filter(event => !LEGACY_WEBHOOK_EVENTS.includes(event as typeof LEGACY_WEBHOOK_EVENTS[number])),
] as const satisfies readonly WebhookEventType[]

export const WEBHOOK_EVENT_ALIASES = {
  'job.completed': 'site.lifecycle.changed',
  'job.failed': 'job.failed',
  'site.completed': 'site.analytics.ready',
  'indexing.completed': 'site.indexing.ready',
  'auth.failed': 'site.auth.failed',
} as const satisfies Record<typeof LEGACY_WEBHOOK_EVENTS[number], CanonicalWebhookEventType>
