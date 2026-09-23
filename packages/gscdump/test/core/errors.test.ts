import { classifyError } from 'gscdump/errors'
import { describe, expect, it } from 'vitest'

function ofetchLike(statusCode: number, message: string, extras: Record<string, unknown> = {}): Error {
  const err = Object.assign(new Error(message), { statusCode, ...extras })
  return err
}

describe('classifyError', () => {
  it('classifies 401 as auth-expired', () => {
    const e = classifyError(ofetchLike(401, 'Invalid Credentials'))
    expect(e.kind).toBe('auth-expired')
    expect(e.message).toBe('Invalid Credentials')
  })

  it('classifies 429 as rate-limited and carries retryAfter', () => {
    const e = classifyError(ofetchLike(429, 'Too Many Requests', {
      headers: { 'retry-after': '45' },
    }))
    expect(e.kind).toBe('rate-limited')
    if (e.kind === 'rate-limited')
      expect(e.retryAfter).toBe(45)
  })

  it('reads retry-after from response.headers fallback', () => {
    const e = classifyError(ofetchLike(429, 'slow down', {
      response: { headers: { 'Retry-After': 30 } },
    }))
    if (e.kind === 'rate-limited')
      expect(e.retryAfter).toBe(30)
    else throw new Error(`expected rate-limited, got ${e.kind}`)
  })

  it.each([
    { headers: new Headers({ 'Retry-After': '12' }) },
    { response: new Response(null, { status: 429, headers: { 'Retry-After': '12' } }) },
  ])('preserves retry timing from native Headers %j', (extras) => {
    const error = ofetchLike(429, 'Too Many Requests', extras)

    expect(classifyError(error)).toMatchObject({ kind: 'rate-limited', retryAfter: 12 })
  })

  it('classifies 403+quota as rate-limited, not auth-expired', () => {
    const e = classifyError(ofetchLike(403, 'Quota exceeded for the day'))
    expect(e.kind).toBe('rate-limited')
  })

  it('classifies 403 without quota keyword as permission-denied', () => {
    const e = classifyError(ofetchLike(403, 'Permission denied for site'))
    expect(e.kind).toBe('permission-denied')
  })

  it.each([
    'Search Analytics load quota exceeded. Please try again later.',
    'Quota exceeded for quota metric \'QPS\' and limit \'QPS per user\'.',
    'Too many requests: QPS limit reached',
  ])('classifies an ofetch 403 whose Google body says %j as rate-limited', (googleMessage) => {
    const e = classifyError(ofetchLike(403, '[POST] "https://searchconsole.googleapis.com/v1/x": 403 Forbidden', {
      data: { error: { code: 403, message: googleMessage } },
    }))
    expect(e).toMatchObject({ kind: 'rate-limited', message: googleMessage })
  })

  it('keeps Google\'s reason when an ofetch Error wraps it', () => {
    const e = classifyError(ofetchLike(403, '[POST] "https://searchconsole.googleapis.com/v1/x": 403 Forbidden', {
      data: { error: { code: 403, message: 'User does not have sufficient permission for site' } },
    }))
    expect(e).toMatchObject({ kind: 'permission-denied', message: 'User does not have sufficient permission for site' })
  })

  it('classifies 403 with quota `reason` in ErrorInfo as rate-limited', () => {
    // FetchError-shaped: data envelope with details[].reason
    const e = classifyError(ofetchLike(403, 'permission denied', {
      data: {
        error: {
          code: 403,
          message: 'permission denied',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', 'reason': 'rateLimitExceeded' }],
        },
      },
    }))
    expect(e.kind).toBe('rate-limited')
  })

  it('classifies 403 with legacy `errors[0].reason` as rate-limited', () => {
    const e = classifyError(ofetchLike(403, 'forbidden', {
      data: { error: { code: 403, message: 'forbidden', errors: [{ reason: 'dailyLimitExceeded' }] } },
    }))
    expect(e.kind).toBe('rate-limited')
  })

  it('treats unknown 403 reason as permission-denied', () => {
    const e = classifyError(ofetchLike(403, 'forbidden', {
      data: { error: { code: 403, message: 'forbidden', errors: [{ reason: 'forbidden' }] } },
    }))
    expect(e.kind).toBe('permission-denied')
  })

  it('classifies 404 and 410 as not-found', () => {
    expect(classifyError(ofetchLike(404, 'gone')).kind).toBe('not-found')
    expect(classifyError(ofetchLike(410, 'gone forever')).kind).toBe('not-found')
  })

  it('classifies 400/402/409/413/422 as validation', () => {
    expect(classifyError(ofetchLike(400, 'bad')).kind).toBe('validation')
    expect(classifyError(ofetchLike(402, 'payment required')).kind).toBe('validation')
    expect(classifyError(ofetchLike(409, 'conflict')).kind).toBe('validation')
    expect(classifyError(ofetchLike(413, 'batch too large')).kind).toBe('validation')
    expect(classifyError(ofetchLike(422, 'unprocessable')).kind).toBe('validation')
  })

  it.each([
    'dailyLimitExceededUnreg',
    'rateLimitExceededUnreg',
    'userRateLimitExceededUnreg',
    'responseTooLarge',
    'limitExceeded',
    'variableTermExpiredDailyExceeded',
  ])('classifies 403 with reason %s as rate-limited', (reason) => {
    const e = classifyError(ofetchLike(403, 'forbidden', {
      data: { error: { code: 403, message: 'forbidden', errors: [{ reason }] } },
    }))
    expect(e.kind).toBe('rate-limited')
  })

  it('classifies 500/unknown as transport and preserves status', () => {
    const e = classifyError(ofetchLike(503, 'backend down'))
    expect(e.kind).toBe('transport')
    if (e.kind === 'transport')
      expect(e.status).toBe(503)
  })

  it('falls back to transport with no status for plain Error', () => {
    const e = classifyError(new Error('socket hang up'))
    expect(e.kind).toBe('transport')
    expect(e.message).toBe('socket hang up')
  })

  it('prefers Google-nested data.error.message over wrapper message', () => {
    const e = classifyError({
      statusCode: 400,
      message: 'HTTP 400',
      data: { error: { message: 'Invalid dimension: foobar' } },
    })
    expect(e.kind).toBe('validation')
    expect(e.message).toBe('Invalid dimension: foobar')
  })

  it('exposes the original as `cause` for downstream inspection', () => {
    const original = ofetchLike(429, 'slow down')
    const e = classifyError(original)
    expect(e.cause).toBe(original)
  })
})
