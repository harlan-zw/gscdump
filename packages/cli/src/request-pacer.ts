// Shared pacing for Google API calls. A full sync runs every table and search
// type at once; without one shared gate the day workers multiply into
// hundreds of concurrent requests and trip Google's Search Analytics quota.

export interface RequestPacer {
  run: <T>(task: () => Promise<T>) => Promise<T>
}

export interface RequestPacerOptions {
  /** Requests in flight at once, across every caller. */
  maxInFlight: number
  /** Request starts per minute, spaced evenly. */
  perMinute: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function createRequestPacer(opts: RequestPacerOptions): RequestPacer {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const spacing = 60_000 / opts.perMinute
  let nextStart = 0
  let inFlight = 0
  const waiting: Array<() => void> = []

  async function acquire(): Promise<void> {
    if (inFlight >= opts.maxInFlight)
      await new Promise<void>(resolve => waiting.push(resolve))
    inFlight++
    // Reserve a start slot before waiting, so concurrent callers get distinct slots.
    const slot = Math.max(now(), nextStart)
    nextStart = slot + spacing
    const wait = slot - now()
    if (wait > 0)
      await sleep(wait)
  }

  function release(): void {
    inFlight--
    waiting.shift()?.()
  }

  return {
    async run(task) {
      await acquire()
      try {
        return await task()
      }
      finally {
        release()
      }
    },
  }
}
