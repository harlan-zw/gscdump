import type {
  CanonicalWebhookEventType,
  CreateWebhookEnvelopeOptions,
  PartnerWebhookHeaders,
  WebhookEnvelope,
  WebhookEventType,
} from '@gscdump/contracts'
import { PartnerApiError } from './errors'
import { partnerWebhookEnvelopeSchema } from '@gscdump/contracts'
import {
  LEGACY_WEBHOOK_EVENTS,
  WEBHOOK_CONTRACT_VERSION,
  WEBHOOK_CONTRACT_VERSION_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_ALIASES,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@gscdump/contracts'
export {
  CANONICAL_WEBHOOK_EVENTS,
  LEGACY_WEBHOOK_EVENTS,
  VALID_WEBHOOK_EVENTS,
  WEBHOOK_CONTRACT_VERSION,
  WEBHOOK_CONTRACT_VERSION_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_ALIASES,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@gscdump/contracts'

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const SECRET_LENGTH = 32

const encoder = new TextEncoder()

// This package is the partner-side consumer SDK. Producer-only helpers below are
// kept internal for contract fixtures and must not become webhook delivery APIs.
function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let value = ''
  for (let i = 0; i < length; i++)
    value += CHARSET[bytes[i]! % CHARSET.length]
  return value
}

function toPayloadString(payload: string | object): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload)
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[\da-f]+$/i.test(hex) || hex.length % 2 !== 0)
    return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false
  let diff = 0
  for (let i = 0; i < a.length; i++)
    diff |= a[i]! ^ b[i]!
  return diff === 0
}

function signatureHex(signature: string): string | null {
  const trimmed = signature.trim()
  return trimmed.startsWith('sha256=') ? trimmed.slice('sha256='.length) : null
}

async function hmacSha256(payload: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', key, encoder.encode(payload))
}

export function generateWebhookSecret(): string {
  return `whsec_${randomString(SECRET_LENGTH)}`
}

export function generateWebhookDeliveryId(): string {
  return `whd_${crypto.randomUUID()}`
}

export function toCanonicalWebhookEvent(event: WebhookEventType): CanonicalWebhookEventType {
  return WEBHOOK_EVENT_ALIASES[event as typeof LEGACY_WEBHOOK_EVENTS[number]] ?? event as CanonicalWebhookEventType
}

export function shouldQueueWebhook(webhookEvents: string | string[] | null | undefined, eventType: WebhookEventType): boolean {
  if (!webhookEvents)
    return false

  const events = Array.isArray(webhookEvents)
    ? webhookEvents
    : JSON.parse(webhookEvents) as string[]

  return events.includes(eventType) || events.includes(toCanonicalWebhookEvent(eventType))
}

export function createWebhookEnvelope<TData extends Record<string, unknown>>(
  options: CreateWebhookEnvelopeOptions<TData>,
): WebhookEnvelope<TData & { legacyEvent?: WebhookEventType }> {
  const occurredAt = options.occurredAt instanceof Date
    ? options.occurredAt.toISOString()
    : options.occurredAt ?? new Date().toISOString()
  const canonicalEvent = toCanonicalWebhookEvent(options.event)
  const legacyPayload = LEGACY_WEBHOOK_EVENTS.includes(options.event as typeof LEGACY_WEBHOOK_EVENTS[number])
    ? { ...options.data, event: options.event }
    : null
  const data = {
    legacyEvent: options.event,
    ...(legacyPayload ? { legacyPayload } : {}),
    ...options.data,
  }

  return {
    contractVersion: options.contractVersion ?? WEBHOOK_CONTRACT_VERSION,
    deliveryId: options.deliveryId ?? generateWebhookDeliveryId(),
    event: canonicalEvent,
    partnerId: options.partnerId,
    userId: options.userId,
    siteId: options.siteId,
    externalUserId: options.externalUserId ?? null,
    externalSiteId: options.externalSiteId ?? null,
    lifecycleRevision: options.lifecycleRevision,
    occurredAt,
    data: data as TData & { legacyEvent?: WebhookEventType },
  }
}

export function serializeWebhookPayload(payload: string | object): string {
  return toPayloadString(payload)
}

export async function signWebhookPayload(payload: string | object, secret: string): Promise<string> {
  const payloadString = toPayloadString(payload)
  return `sha256=${bytesToHex(await hmacSha256(payloadString, secret))}`
}

export async function verifyWebhookSignature(payload: string | object, signature: string | null | undefined, secret: string): Promise<boolean> {
  if (!signature)
    return false
  const hex = signatureHex(signature)
  if (!hex)
    return false
  const received = hexToBytes(hex)
  if (!received)
    return false
  const expected = new Uint8Array(await hmacSha256(toPayloadString(payload), secret))
  return constantTimeEqual(expected, received)
}

export async function parseWebhookPayload<TData extends Record<string, unknown> = Record<string, unknown>>(
  payload: string | object,
  options: {
    secret?: string
    signature?: string | null
    headers?: PartnerWebhookHeaders | Headers
    validateSignature?: boolean
  } = {},
): Promise<WebhookEnvelope<TData>> {
  const payloadString = toPayloadString(payload)
  const signature = options.signature ?? readWebhookHeaders(options.headers).signature

  if (options.secret && (options.validateSignature ?? true)) {
    const valid = await verifyWebhookSignature(payloadString, signature, options.secret)
    if (!valid) {
      throw new PartnerApiError({
        kind: 'auth',
        statusCode: 401,
        message: 'Invalid webhook signature',
      })
    }
  }

  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  return partnerWebhookEnvelopeSchema.parse(parsed) as WebhookEnvelope<TData>
}

export function readWebhookHeaders(headers: Headers | PartnerWebhookHeaders | null | undefined): Required<PartnerWebhookHeaders> {
  if (!headers) {
    return {
      event: null,
      delivery: null,
      contractVersion: null,
      timestamp: null,
      signature: null,
    }
  }

  if (headers instanceof Headers) {
    return {
      event: headers.get(WEBHOOK_EVENT_HEADER),
      delivery: headers.get(WEBHOOK_DELIVERY_HEADER),
      contractVersion: headers.get(WEBHOOK_CONTRACT_VERSION_HEADER),
      timestamp: headers.get(WEBHOOK_TIMESTAMP_HEADER),
      signature: headers.get(WEBHOOK_SIGNATURE_HEADER),
    }
  }

  return {
    event: headers.event ?? null,
    delivery: headers.delivery ?? null,
    contractVersion: headers.contractVersion ?? null,
    timestamp: headers.timestamp ?? null,
    signature: headers.signature ?? null,
  }
}
