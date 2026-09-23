import { describe, expect, it } from 'vitest'
import { createRequestPacer } from '../src/request-pacer'

describe('createRequestPacer', () => {
  it('spaces request starts to the per-minute rate', async () => {
    const waits: number[] = []
    const pacer = createRequestPacer({
      maxInFlight: 10,
      perMinute: 600,
      now: () => 0,
      sleep: async (ms) => { waits.push(ms) },
    })
    await Promise.all(Array.from({ length: 5 }, () => pacer.run(async () => {})))
    // The first start is immediate; each later start waits 100ms more.
    expect(waits).toEqual([100, 200, 300, 400])
  })

  it('never runs more than maxInFlight tasks at once', async () => {
    const pacer = createRequestPacer({ maxInFlight: 2, perMinute: 1_000_000 })
    let active = 0
    let peak = 0
    await Promise.all(Array.from({ length: 8 }, () => pacer.run(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
    })))
    expect(peak).toBe(2)
  })

  it('frees the slot when a task throws', async () => {
    const pacer = createRequestPacer({ maxInFlight: 1, perMinute: 1_000_000 })
    await expect(pacer.run(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(pacer.run(async () => 'ok')).resolves.toBe('ok')
  })
})
