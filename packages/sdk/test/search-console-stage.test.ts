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

  it('renders negative growth evidence without a duplicated plus sign', () => {
    const stage = classifySearchConsoleStage({
      connected: true,
      summary: { totalUrls: 100, indexed: 90, indexedPercent: 90 },
      issues: [],
      sitemaps: [{ urlCount: 100 }],
      impressions28d: 50000,
      trajectory: {
        clicksPct90d: -5,
        impressionsPct90d: 30,
        positionDelta90d: -1,
      },
    })

    expect(stage.key).toBe('healthy_growth_ready')
    expect(stage.evidence.find(evidence => evidence.label === 'Clicks 90d')?.value).toBe('-5.0%')
    expect(stage.evidence.find(evidence => evidence.label === 'Impressions 90d')?.value).toBe('+30.0%')
  })

  it('keeps mutable finding-type arrays isolated between classifications', () => {
    const input = { connected: false }
    const first = classifySearchConsoleStage(input)
    const second = classifySearchConsoleStage(input)

    first.sprintFindingTypes.push('local-only')

    expect(second.sprintFindingTypes).toEqual([])
  })

  it('includes zero-click pages in the low-ranking cohort while counting both in one pass', () => {
    const stage = classifySearchConsoleStage({
      connected: true,
      summary: { totalUrls: 100, indexed: 100, indexedPercent: 100 },
      issues: [],
      sitemaps: [{ urlCount: 100 }],
      impressions28d: 50000,
      pageInventory: [
        { impressions: 100, clicks: 0, position: 25 },
        { impressions: 100, clicks: 2, position: 30 },
        { impressions: 100, clicks: 2, position: 10 },
        { impressions: 100, clicks: 2, position: 10 },
        { impressions: 100, clicks: 2, position: 10 },
      ],
    })

    expect(stage.key).toBe('ranking_stalled')
    expect(stage.evidence).toContainEqual(expect.objectContaining({ label: 'Low-ranking visible pages', value: '2' }))
  })
})
