export type AppendIdentity
  = { _tag: 'Explicit', appendId: string }
    | { _tag: 'Content', appendId: string, legacyAppendId: string }

type ContentValue = string | ContentValue[]

function encodeValue(value: unknown): ContentValue {
  if (value === null)
    return ['null']
  if (typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol')
      throw new TypeError('Append records contain an unsupported value.')
    return [typeof value, Object.is(value, -0) ? '-0' : String(value)]
  }
  if (value instanceof Date)
    return ['date', value.toISOString()]
  if (value instanceof Uint8Array)
    return ['bytes', Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')]
  if (Array.isArray(value))
    return ['array', Array.from(value, encodeValue)]
  if (value instanceof Map) {
    const entries = Array.from(value, ([key, entry]) => JSON.stringify([encodeValue(key), encodeValue(entry)])).sort()
    return ['map', entries]
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new TypeError('Append records contain an unsupported value.')
  return ['object', Object.keys(value).sort().map(key => [key, encodeValue((value as Record<string, unknown>)[key])])]
}

async function hashContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Preserve row multiplicity while ignoring row and object key order. */
export async function deriveAppendIdentity(records: readonly Record<string, unknown>[]): Promise<AppendIdentity> {
  if (!records.length)
    return { _tag: 'Explicit', appendId: crypto.randomUUID() }
  const contentHash = await hashContent(JSON.stringify(records.map(record => JSON.stringify(encodeValue(record))).sort()))
  // Hash sequentially so both serialized batches need not remain in memory.
  const legacyAppendId = await hashContent(records.map(record => Object.keys(record).sort().map(key => `${key}=${String(record[key])}`).join('')).sort().join(''))
  return { _tag: 'Content', appendId: `content-v2:${contentHash}`, legacyAppendId }
}
