import { describe, expect, it } from 'vitest'
import { GSC_WRITE_SCOPE, hasGoogleScope, hasGscReadScope, hasGscWriteScope } from '../../src'

describe('scope matching', () => {
  it('matches full Google scope URIs and exact bare suffixes', () => {
    expect(hasGoogleScope(['webmasters', 'indexing'], GSC_WRITE_SCOPE)).toBe(true)
    expect(hasGoogleScope([GSC_WRITE_SCOPE], GSC_WRITE_SCOPE)).toBe(true)
  })

  it('does not treat readonly Search Console scope as write access', () => {
    expect(hasGscReadScope(['webmasters.readonly'])).toBe(true)
    expect(hasGscWriteScope(['webmasters.readonly'])).toBe(false)
  })
})
