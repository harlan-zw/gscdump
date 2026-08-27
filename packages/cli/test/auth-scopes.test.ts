import {
  GSC_INDEXING_SCOPE,
  GSC_SITE_VERIFICATION_SCOPE,
  GSC_WRITE_SCOPE,
} from 'gscdump'
import { describe, expect, it } from 'vitest'
import { missingRequiredScopes } from '../src/auth-scopes'

describe('required Google scopes', () => {
  it('accepts full scope URIs and bare scope names', () => {
    expect(missingRequiredScopes([
      GSC_WRITE_SCOPE,
      'indexing',
      'siteverification',
    ])).toEqual([])
  })

  it('returns each missing scope as its full URI', () => {
    expect(missingRequiredScopes(['webmasters.readonly'])).toEqual([
      GSC_WRITE_SCOPE,
      GSC_INDEXING_SCOPE,
      GSC_SITE_VERIFICATION_SCOPE,
    ])
  })
})
