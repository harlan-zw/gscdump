import { describe, expect, it } from 'vitest'
import { classifyGscError } from '../src/gsc-error'

describe('classifyGscError', () => {
  it('preserves retry hints for temporary service outages', () => {
    expect(classifyGscError({
      statusCode: 503,
      message: 'R2 SQL temporarily unavailable',
      data: { retryAfterSeconds: 30 },
    })).toEqual({
      status: 'network',
      code: 503,
      message: 'R2 SQL temporarily unavailable',
      retryAfter: 30,
    })
  })

  it('preserves rate-limit retry hints', () => {
    expect(classifyGscError({
      statusCode: 429,
      data: { message: 'Rate limited', retryAfter: 60 },
    })).toEqual({
      status: 'rate-limited',
      code: 429,
      message: 'Rate limited',
      retryAfter: 60,
    })
  })
})
