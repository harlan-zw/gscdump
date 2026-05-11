import { describe, expect, it } from 'vitest'
import {
  GSCDUMP_ONBOARDING_CONTRACT_VERSION,
  GSCDUMP_OPTIONAL_INDEXING_SCOPE,
  GSCDUMP_REQUIRED_ANALYTICS_SCOPE,
  accountStatuses,
  analyticsStatuses,
  hasOptionalIndexingScope,
  hasRequiredAnalyticsScope,
  indexingStatuses,
  lifecycleErrorCodes,
  parseGrantedScopes,
} from '../src/onboarding'

describe('partner onboarding contract', () => {
  it('exports stable lifecycle state vocabularies', () => {
    expect(GSCDUMP_ONBOARDING_CONTRACT_VERSION).toBe('2026-05-11')
    expect(accountStatuses).toContain('db_provisioning')
    expect(accountStatuses).toContain('reauth_required')
    expect(analyticsStatuses).toContain('queryable_live')
    expect(analyticsStatuses).toContain('queryable_partial')
    expect(indexingStatuses).toContain('missing_scope')
    expect(indexingStatuses).toContain('insufficient_permission')
    expect(lifecycleErrorCodes).toContain('missing_refresh_token')
    expect(lifecycleErrorCodes).toContain('permission_lost')
  })

  it('parses and checks onboarding OAuth scopes', () => {
    const scopes = `${GSCDUMP_REQUIRED_ANALYTICS_SCOPE} ${GSCDUMP_OPTIONAL_INDEXING_SCOPE}`

    expect(parseGrantedScopes(scopes)).toEqual([
      GSCDUMP_REQUIRED_ANALYTICS_SCOPE,
      GSCDUMP_OPTIONAL_INDEXING_SCOPE,
    ])
    expect(hasRequiredAnalyticsScope(scopes)).toBe(true)
    expect(hasOptionalIndexingScope(scopes)).toBe(true)
    expect(hasRequiredAnalyticsScope(GSCDUMP_OPTIONAL_INDEXING_SCOPE)).toBe(false)
  })
})

