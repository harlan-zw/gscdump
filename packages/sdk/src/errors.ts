export type PartnerErrorKind
  = | 'auth'
    | 'rate-limit'
    | 'provisioning'
    | 'permission'
    | 'network'
    | 'validation'
    | 'not-found'
    | 'server'
    | 'unknown'

export interface PartnerErrorInfo {
  kind: PartnerErrorKind
  statusCode?: number
  message: string
  data?: unknown
}

export class PartnerApiError extends Error {
  readonly kind: PartnerErrorKind
  readonly statusCode?: number
  readonly data?: unknown

  constructor(info: PartnerErrorInfo) {
    super(info.message)
    this.name = 'PartnerApiError'
    this.kind = info.kind
    this.statusCode = info.statusCode
    this.data = info.data
  }
}

function statusOf(error: unknown): number | undefined {
  const rec = error as {
    statusCode?: number
    status?: number
    response?: { status?: number }
  }
  return rec.statusCode ?? rec.status ?? rec.response?.status
}

function messageOf(error: unknown): string {
  const rec = error as {
    data?: { message?: string, statusMessage?: string }
    message?: string
    statusMessage?: string
  }
  return rec.data?.message ?? rec.data?.statusMessage ?? rec.message ?? rec.statusMessage ?? String(error)
}

function kindOf(status: number | undefined, message: string): PartnerErrorKind {
  if (status === 401 || status === 403)
    return 'auth'
  if (status === 404)
    return 'not-found'
  if (status === 409 || /provision/i.test(message))
    return 'provisioning'
  if (status === 429)
    return 'rate-limit'
  if (status === 400 || status === 422)
    return 'validation'
  if (/permission|reauth|access/i.test(message))
    return 'permission'
  if (status && status >= 500)
    return 'server'
  if (!status)
    return 'network'
  return 'unknown'
}

export function toPartnerError(error: unknown): PartnerApiError {
  if (error instanceof PartnerApiError)
    return error
  const statusCode = statusOf(error)
  const message = messageOf(error)
  const data = (error as { data?: unknown })?.data
  return new PartnerApiError({
    kind: kindOf(statusCode, message),
    statusCode,
    message,
    data,
  })
}

/** Narrow an unknown error to the modelled `PartnerApiError`. */
export function isPartnerError(error: unknown): error is PartnerApiError {
  return error instanceof PartnerApiError
}

/** Human-readable, log-friendly rendering of a modelled partner failure. */
export function formatPartnerError(error: PartnerApiError): string {
  const status = error.statusCode != null ? ` (${error.statusCode})` : ''
  return `[${error.kind}]${status} ${error.message}`
}

/**
 * Re-raise a modelled `PartnerApiError` as itself. The error variant of every
 * `*Result` core already IS the throwable `PartnerApiError`, so the throwing
 * wrappers preserve the exact identity/message existing call sites and tests
 * assert (`rejects.toThrow(PartnerApiError)`, `toThrow('Invalid webhook signature')`).
 */
export function partnerErrorToException(error: PartnerApiError): PartnerApiError {
  return error
}
