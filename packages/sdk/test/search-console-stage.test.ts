import { describe, expect, it } from 'vitest'
import { classifySearchConsoleStage } from '../src'

describe('classifySearchConsoleStage canonical clamp', () => {
  it('canonical mismatches on a fully-indexed sample cannot block indexability (unhead.unjs.io regression)', () => {
    // The inspected/sitemap-scoped funnel had 8 URLs all indexed (notIndexed = 0),
    // but the canonical-mismatch endpoint (pre-fix, unscoped) returned 31 — an
    // impossible 31-of-8 that fired `indexability_blocked` while coverage read 100%.
    // A mismatch on a page Google indexed anyway is not a blocker: clamping to the
    // non-indexed pool (0 here) makes the count unable to out-vote the funnel.
    const stage = classifySearchConsoleStage({
      connected: true,
      summary: { totalUrls: 8, indexed: 8, indexedPercent: 100 },
      issues: [],
      sitemaps: [{ urlCount: 148 }],
      canonicalMismatchCount: 31,
    })

    expect(stage.key).not.toBe('indexability_blocked')
  })

  it('genuinely high in-set canonical mismatches still flag indexability_blocked', () => {
    // Reconciled data: when the mismatch count is real within the non-indexed pool
    // (40 of 100 total, 10 non-indexed), the gate must still fire — the clamp only
    // kills impossible counts, it does not suppress a real canonical problem.
    const stage = classifySearchConsoleStage({
      connected: true,
      summary: { totalUrls: 100, indexed: 90, indexedPercent: 90 },
      issues: [],
      sitemaps: [{ urlCount: 100 }],
      impressions28d: 50000,
      canonicalMismatchCount: 40,
    })

    expect(stage.key).toBe('indexability_blocked')
  })
})
