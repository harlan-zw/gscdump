export type AppendIdentity
  = { _tag: 'Explicit', appendId: string }
    | { _tag: 'Content', appendId: string, legacyAppendId: string }

type ContentValue = string | ContentValue[]

function encodeValue(value: unknown): ContentValue {
  if (value === null)
    return 'null'
  if (typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol')
      throw new TypeError('Append records contain an unsupported value.')
    return `${typeof value}:${Object.is(value, -0) ? '-0' : String(value)}`
  }
  if (value instanceof Date)
    return `date:${value.toISOString()}`
  if (value instanceof Uint8Array)
    return `bytes:${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`
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
  // Finish the smaller legacy batch before allocating the framed batch.
  const legacyAppendId = await hashContent(records.map(record => Object.keys(record).sort().map(key => `${key}=${String(record[key])}`).join('')).sort().join(''))
  const groups = new Map<string, string[]>()
  for (const record of records) {
    if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)
      throw new TypeError('Append records contain an unsupported value.')
    const keys = Object.keys(record).sort()
    const schema = JSON.stringify(keys)
    const row = JSON.stringify(keys.map(key => encodeValue(record[key])))
    const group = groups.get(schema)
    if (group)
      group.push(row)
    else
      groups.set(schema, [row])
  }
  // Shared schemas avoid repeating field names. Complete JSON rows retain framing.
  const content = `[${Array.from(groups, ([schema, rows]) => `[${schema},[${rows.sort().join(',')}]]`).sort().join(',')}]`
  groups.clear()
  const contentHash = await hashContent(content)
  return { _tag: 'Content', appendId: `content-v2:${contentHash}`, legacyAppendId }
}
