import { describe, expect, it, vi } from 'vitest'
import { createObjectAsyncLock, createSharedAsyncResource } from '../src/shared-runtime'

describe('createSharedAsyncResource', () => {
  it('shares an in-flight load and retries after the cooldown', async () => {
    let now = 0
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ready: true })
    const resource = createSharedAsyncResource({
      load,
      now: () => now,
      retryCooldownMs: 100,
    })

    await expect(resource.get()).rejects.toThrow('offline')
    await expect(resource.get()).rejects.toThrow('offline')
    expect(load).toHaveBeenCalledOnce()
    now = 100
    const [first, second] = await Promise.all([resource.get(), resource.get()])
    expect(first).toBe(second)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('createObjectAsyncLock', () => {
  it('serializes work per key while keeping separate keys independent', async () => {
    const lock = createObjectAsyncLock<object>()
    const firstKey = {}
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = lock.run(firstKey, async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
    })
    const second = lock.run(firstKey, async () => {
      order.push('second')
    })
    await lock.run({}, async () => {
      order.push('other')
    })
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'other', 'first:end', 'second'])
  })
})
