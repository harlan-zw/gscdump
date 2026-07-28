import { describe, expect, it } from 'vitest'
import {
  classifySitemapCollapse,
  SITEMAP_SYNC_COLLAPSE_POLICY,
  SITEMAP_TRUST_COLLAPSE_POLICY,
  sitemapHistoryHasCollapse,
} from '../src/sitemap-health'

describe('sitemap collapse policies', () => {
  it('keeps sync mutation conservative across two strikes', () => {
    expect(classifySitemapCollapse([8, 148, 146], SITEMAP_SYNC_COLLAPSE_POLICY))
      .toMatchObject({ _tag: 'awaiting_confirmation', current: 8, highWater: 148 })
    expect(classifySitemapCollapse([7, 8, 148], SITEMAP_SYNC_COLLAPSE_POLICY))
      .toMatchObject({ _tag: 'persisted', current: 7, highWater: 148 })
    expect(classifySitemapCollapse([150, 8, 148], SITEMAP_SYNC_COLLAPSE_POLICY))
      .toMatchObject({ _tag: 'recovered_blip', current: 150, highWater: 148 })
  })

  it('keeps the UI trust policy sensitive only to an 80 percent collapse', () => {
    expect(classifySitemapCollapse([25, 100, 100], SITEMAP_TRUST_COLLAPSE_POLICY)._tag).toBe('none')
    expect(classifySitemapCollapse([10, 100, 100], SITEMAP_TRUST_COLLAPSE_POLICY)._tag).toBe('awaiting_confirmation')
    expect(sitemapHistoryHasCollapse([10, 100, 90], SITEMAP_TRUST_COLLAPSE_POLICY)).toBe(true)
  })
})
