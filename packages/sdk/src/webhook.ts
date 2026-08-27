import type {
  PartnerWebhookHeaders,
  WebhookEnvelope,
} from '@gscdump/contracts'
import type { Result } from 'gscdump/result'
import { partnerWebhookEnvelopeSchema, WEBHOOK_CONTRACT_VERSION_HEADER, WEBHOOK_DELIVERY_HEADER, WEBHOOK_EVENT_HEADER, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '@gscdump/contracts'
import { err, ok, unwrapResult } from 'gscdump/result'
import { PartnerApiError, partnerErrorToException } from './errors'

export {
  CANONICAL_WEBHOOK_EVENTS,
  VALID_WEBHOOK_EVENTS,
  WEBHOOK_CONTRACT_VERSION,
  WEBHOOK_CONTRACT_VERSION_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@gscdump/contracts'

const encoder = new TextEncoder()

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

/**
 * Errors-as-values core for {@link parseWebhookPayload}: a failed HMAC signature
 * check is a caller-actionable `auth` (401) failure at the webhook boundary, so
 * it is returned as a modelled `PartnerApiError` rather than only thrown. A
 * malformed envelope (schema parse) is a defect and keeps propagating.
 */
async function parseWebhookPayloadResult<TData extends Record<string, unknown> = Record<string, unknown>>(
  payload: string | object,
  options: {
    secret?: string
    signature?: string | null
    headers?: PartnerWebhookHeaders | Headers
    validateSignature?: boolean
  } = {},
): Promise<Result<WebhookEnvelope<TData>, PartnerApiError>> {
  const payloadString = toPayloadString(payload)
  const signature = options.signature ?? readWebhookHeaders(options.headers).signature

  if (options.secret && (options.validateSignature ?? true)) {
    const valid = await verifyWebhookSignature(payloadString, signature, options.secret)
    if (!valid) {
      return err(new PartnerApiError({
        kind: 'auth',
        statusCode: 401,
        message: 'Invalid webhook signature',
      }))
    }
  }

  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  return ok(partnerWebhookEnvelopeSchema.parse(parsed) as WebhookEnvelope<TData>)
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
  return unwrapResult(await parseWebhookPayloadResult<TData>(payload, options), partnerErrorToException)
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
