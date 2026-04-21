import { describe, expect, it } from 'vitest'

import { analyzeActionPriority } from '../src/action-priority'

describe('analyzeActionPriority', () => {
  it('normalizes, merges, and ranks actions across analyzer outputs', async () => {
    const result = await analyzeActionPriority({
      async analyze(params) {
        switch (params.type) {
          case 'striking-distance':
            return {
              results: [
                {
                  keyword: 'alpha',
                  page: '/a',
                  clicks: 10,
                  impressions: 400,
                  ctr: 0.025,
                  position: 6,
                  potentialClicks: 60,
                },
              ],
              meta: {},
            }
          case 'opportunity':
            return {
              results: [
                {
                  keyword: 'alpha',
                  page: '/a',
                  clicks: 10,
                  impressions: 400,
                  ctr: 0.025,
                  position: 6,
                  opportunityScore: 80,
                  potentialClicks: 30,
                  factors: {},
                },
                {
                  keyword: 'beta',
                  page: '/b',
                  clicks: 5,
                  impressions: 800,
                  ctr: 0.01,
                  position: 12,
                  opportunityScore: 55,
                  potentialClicks: 100,
                  factors: {},
                },
              ],
              meta: {},
            }
          case 'cannibalization':
            return {
              results: [
                {
                  keyword: 'alpha',
                  totalImpressions: 500,
                  totalClicks: 20,
                  competitorCount: 2,
                  leaderUrl: '/a',
                  leaderCtr: 0.04,
                  leaderPosition: 4,
                  hhi: 2000,
                  fragmentation: 0.5,
                  stolenClicks: 15,
                  severity: 45,
                  competitors: [],
                },
              ],
              meta: {},
            }
          default:
            return { results: [], meta: {} }
        }
      },
    })

    expect(result.totalSignals).toBe(4)
    expect(result.actions).toHaveLength(2)

    const [first, second] = result.actions
    expect(first.keyword).toBe('alpha')
    expect(first.page).toBe('/a')
    expect(first.sources.sort()).toEqual(['cannibalization', 'opportunity', 'striking-distance'])
    expect(first.impact).toBe(105)
    expect(first.priorityScore).toBeGreaterThan(second.priorityScore)
    expect(result.sources.find(s => s.source === 'change-point')?.status).toBe('skipped')
  })

  it('continues on analyzer errors by default', async () => {
    const result = await analyzeActionPriority({
      async analyze(params) {
        if (params.type === 'ctr-anomaly')
          throw new Error('boom')
        return { results: [], meta: {} }
      },
    })

    expect(result.actions).toEqual([])
    expect(result.sources.find(s => s.source === 'ctr-anomaly')).toMatchObject({
      status: 'error',
      error: 'boom',
    })
  })
})
