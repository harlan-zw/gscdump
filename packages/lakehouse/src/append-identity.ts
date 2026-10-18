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

type DigestStreamConstructor = new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> }

// Bound the joined text and UTF-8 working buffers, not the retained records or
// sorted per-row strings. Coalescing avoids a stream write/promise per row.
function* boundedText(parts: Iterable<string>): Generator<string> {
  const maxUnits = 65_536
  let pending = ''
  for (const part of parts) {
    for (let at = 0; at < part.length;) {
      const take = Math.min(maxUnits - pending.length, part.length - at)
      pending += part.slice(at, at + take)
      at += take
      if (pending.length === maxUnits) {
        yield pending
        pending = ''
      }
    }
  }
  if (pending.length)
    yield pending
}

async function hashFragments(parts: Iterable<string>, DigestStream: DigestStreamConstructor): Promise<string> {
  const digest = new DigestStream('SHA-256')
  // One encoder preserves a high surrogate across writes, including between
  // legacy rows; encoding each chunk separately would change existing IDs.
  const encoder = new TextEncoderStream()
  const writer = encoder.writable.getWriter()
  const pipe = encoder.readable.pipeTo(digest)
  const result = digest.digest
  const finished = Promise.all([pipe, result])
  void finished.catch(() => {})
  try {
    for (const chunk of boundedText(parts))
      await writer.write(chunk)
    await writer.close()
    const [, hash] = await finished
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  }
  catch (error) {
    await writer.abort(error).catch(() => {})
    await Promise.allSettled([pipe, result])
    throw error
  }
  finally {
    writer.releaseLock()
  }
}

async function hashLegacy(records: readonly Record<string, unknown>[], DigestStream: DigestStreamConstructor | undefined): Promise<string> {
  const rows = records.map(record => Object.keys(record).sort().map(key => `${key}=${String(record[key])}`).join('')).sort()
  return DigestStream ? hashFragments(rows, DigestStream) : hashContent(rows.join(''))
}

function* framedParts(groups: Map<string, string[]>): Generator<string> {
  yield '['
  let firstGroup = true
  // Complete JSON-array schema strings cannot be strict prefixes of each
  // other, so this equals sorting the old `[${schema},[...]]` group strings.
  for (const schema of Array.from(groups.keys()).sort()) {
    if (!firstGroup)
      yield ','
    firstGroup = false
    yield '['
    yield schema
    yield ',['
    let firstRow = true
    for (const row of groups.get(schema)!.sort()) {
      if (!firstRow)
        yield ','
      firstRow = false
      yield row
    }
    yield ']]'
  }
  yield ']'
}

/** Preserve row multiplicity while ignoring row and object key order. */
export async function deriveAppendIdentity(records: readonly Record<string, unknown>[]): Promise<AppendIdentity> {
  if (!records.length)
    return { _tag: 'Explicit', appendId: crypto.randomUUID() }
  const available = (crypto as typeof crypto & { DigestStream?: DigestStreamConstructor }).DigestStream
  const DigestStream = typeof available === 'function' && typeof TextEncoderStream === 'function' ? available : undefined
  // Finish the smaller legacy batch before allocating the framed batch.
  const legacyAppendId = await hashLegacy(records, DigestStream)
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
  if (DigestStream) {
    const contentHash = await hashFragments(framedParts(groups), DigestStream)
    groups.clear()
    return { _tag: 'Content', appendId: `content-v2:${contentHash}`, legacyAppendId }
  }
  // Shared schemas avoid repeating field names. Complete JSON rows retain framing.
  const content = `[${Array.from(groups, ([schema, rows]) => `[${schema},[${rows.sort().join(',')}]]`).sort().join(',')}]`
  groups.clear()
  const contentHash = await hashContent(content)
  return { _tag: 'Content', appendId: `content-v2:${contentHash}`, legacyAppendId }
}
