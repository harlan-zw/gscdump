// Coalesce concurrent identical async operations onto a single in-flight
// promise. The map entry is cleared when the promise settles, so a fresh
// caller after settlement starts a new run.

export interface InflightDedupe<T> {
  dedupe: (key: string, run: () => Promise<T>) => Promise<T>
  has: (key: string) => boolean
  clear: () => void
}

export function createInflightDedupe<T>(): InflightDedupe<T> {
  const inflight = new Map<string, Promise<T>>()
  return {
    dedupe(key, run) {
      const existing = inflight.get(key)
      if (existing)
        return existing
      const promise = run().finally(() => {
        if (inflight.get(key) === promise)
          inflight.delete(key)
      })
      inflight.set(key, promise)
      return promise
    },
    has(key) {
      return inflight.has(key)
    },
    clear() {
      inflight.clear()
    },
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => {
      return `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
    }).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashString(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export interface HostedR2QueryKeyInput {
  userId: string | number
  siteId: string
  state: unknown
  comparison?: unknown
  comparisonFilter?: string
}

export function getHostedR2QueryKey(input: HostedR2QueryKeyInput): string {
  return [
    input.userId,
    input.siteId,
    hashString(stableStringify(input.state)),
    input.comparison ? hashString(stableStringify(input.comparison)) : '',
    input.comparisonFilter ?? '',
  ].join(':')
}
