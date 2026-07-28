export type SharedAsyncResourceState
  = | {
    _tag: 'idle' | 'loading' | 'ready'
    consecutiveFailures: number
    lastFailureAt: null
  }
  | {
    _tag: 'cooldown' | 'exhausted'
    consecutiveFailures: number
    lastFailureAt: number
    error: unknown
  }

export interface SharedAsyncResourceOptions<T> {
  load: () => Promise<T>
  retryCooldownMs?: number
  maxConsecutiveFailures?: number
  now?: () => number
  onStateChange?: (state: SharedAsyncResourceState) => void
}

export interface SharedAsyncResource<T> {
  get: () => Promise<T>
  state: () => SharedAsyncResourceState
  reset: () => void
}

export function createSharedAsyncResource<T>(
  options: SharedAsyncResourceOptions<T>,
): SharedAsyncResource<T> {
  const now = options.now ?? Date.now
  const retryCooldownMs = options.retryCooldownMs ?? 30_000
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3
  let promise: Promise<T> | null = null
  let current: SharedAsyncResourceState = {
    _tag: 'idle',
    consecutiveFailures: 0,
    lastFailureAt: null,
  }

  const update = (state: SharedAsyncResourceState): void => {
    current = state
    options.onStateChange?.(state)
  }

  const get = (): Promise<T> => {
    if (promise)
      return promise
    if (current.consecutiveFailures >= maxConsecutiveFailures) {
      if (current._tag !== 'cooldown' && current._tag !== 'exhausted')
        return Promise.reject(new Error('shared resource exhausted without a recorded failure'))
      update({ ...current, _tag: 'exhausted' })
      return Promise.reject(current.error)
    }
    if (
      (current._tag === 'cooldown' || current._tag === 'exhausted')
      && now() - current.lastFailureAt < retryCooldownMs
    ) {
      update({ ...current, _tag: 'cooldown' })
      return Promise.reject(current.error)
    }

    update({
      _tag: 'loading',
      consecutiveFailures: current.consecutiveFailures,
      lastFailureAt: null,
    })
    promise = options.load().then(
      (resource) => {
        update({ _tag: 'ready', consecutiveFailures: 0, lastFailureAt: null })
        return resource
      },
      (error) => {
        promise = null
        update({
          _tag: 'cooldown',
          consecutiveFailures: current.consecutiveFailures + 1,
          lastFailureAt: now(),
          error,
        })
        throw error
      },
    )
    return promise
  }

  return {
    get,
    state: () => current,
    reset: () => {
      promise = null
      update({ _tag: 'idle', consecutiveFailures: 0, lastFailureAt: null })
    },
  }
}

export interface ObjectAsyncLock<T extends object> {
  run: <R>(key: T, task: () => Promise<R>) => Promise<R>
}

export function createObjectAsyncLock<T extends object>(
  onRejected?: (error: unknown) => void,
): ObjectAsyncLock<T> {
  const chains = new WeakMap<T, Promise<void>>()
  return {
    run<R>(key: T, task: () => Promise<R>): Promise<R> {
      const result = (chains.get(key) ?? Promise.resolve()).then(task)
      chains.set(key, result.then(
        () => undefined,
        (error) => {
          // The returned task still rejects. Only recover the internal queue
          // so a failed mutation cannot permanently block later mutations.
          onRejected?.(error)
        },
      ))
      return result
    },
  }
}
