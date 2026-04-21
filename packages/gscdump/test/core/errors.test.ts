import { describe, expect, it } from 'vitest'
import { classifyError, formatErrorForCli, storageError } from '../../src/core/errors'

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

  it('classifies 403+quota as rate-limited, not auth-expired', () => {
    const e = classifyError(ofetchLike(403, 'Quota exceeded for the day'))
    expect(e.kind).toBe('rate-limited')
  })

  it('classifies 403 without quota keyword as auth-expired', () => {
    const e = classifyError(ofetchLike(403, 'Permission denied for site'))
    expect(e.kind).toBe('auth-expired')
  })

  it('classifies 404 as not-found', () => {
    expect(classifyError(ofetchLike(404, 'gone')).kind).toBe('not-found')
  })

  it('classifies 400 and 422 as validation', () => {
    expect(classifyError(ofetchLike(400, 'bad')).kind).toBe('validation')
    expect(classifyError(ofetchLike(422, 'unprocessable')).kind).toBe('validation')
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

describe('storageError', () => {
  it('tags with kind=storage and carries the cause', () => {
    const cause = new Error('ENOENT')
    const e = storageError('manifest missing', cause)
    expect(e.kind).toBe('storage')
    expect(e.message).toBe('manifest missing')
    expect(e.cause).toBe(cause)
  })
})

describe('formatErrorForCli', () => {
  it('adds a re-auth hint for auth-expired', () => {
    const out = formatErrorForCli(ofetchLike(401, 'Invalid Credentials'))
    expect(out).toContain('Invalid Credentials')
    expect(out).toContain('`gscdump auth`')
  })

  it('mentions retryAfter for rate-limited', () => {
    const out = formatErrorForCli(ofetchLike(429, 'too many', {
      headers: { 'retry-after': '12' },
    }))
    expect(out).toContain('12s')
  })

  it('mentions daily quota for Indexing API rate-limited errors', () => {
    const out = formatErrorForCli(ofetchLike(403, 'Quota exceeded for Indexing API'))
    expect(out).toContain('Indexing API')
  })

  it('is terse for transport errors (no suggestion)', () => {
    const out = formatErrorForCli(new Error('socket hang up'))
    expect(out.split('\n')).toHaveLength(1)
  })
})
