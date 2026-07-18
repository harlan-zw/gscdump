import { describe, expect, it } from 'vitest'
import { utf8Size } from '../src/utf8'

describe('utf8Size', () => {
  it.each([
    '',
    'plain ascii',
    'café',
    '日本語',
    '🚀 rocket',
    '\uD800',
    '\uDC00',
    'a🚀é日z',
  ])('matches TextEncoder for %j', (value) => {
    expect(utf8Size(value)).toBe(new TextEncoder().encode(value).byteLength)
  })
})
