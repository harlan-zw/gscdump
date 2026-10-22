/** Bounded Compact Protocol page-header reader. Statistics are skipped, never materialized. */
export interface BoundedPageHeader {
  bytes: number
  kind: number
  compressed: number
  uncompressed: number
  count: number
  encoding: number
  definitionEncoding?: number
  repetitionEncoding?: number
  nulls?: number
  rows?: number
  definitions?: number
  repetitions?: number
  isCompressed?: boolean
}

export class BoundedHeaderTruncatedError extends Error {
  constructor() { super('bounded Parquet truncated page header') }
}

export function boundedPageHeader(bytes: ArrayBuffer): BoundedPageHeader {
  const view = new DataView(bytes)
  let offset = 0
  let fields = 0
  const take = (length: number): number => {
    if (!Number.isSafeInteger(length) || length < 0)
      throw new Error('bounded Parquet invalid page-header size')
    if (offset + length > view.byteLength)
      throw new BoundedHeaderTruncatedError()
    const start = offset
    offset += length
    return start
  }
  const byte = (): number => view.getUint8(take(1))
  const varint = (): number => {
    let value = 0
    for (let shift = 0; shift < 49; shift += 7) {
      const b = byte()
      value += (b & 127) * 2 ** shift
      if (!(b & 128) && Number.isSafeInteger(value))
        return value
    }
    throw new Error('bounded Parquet invalid header integer')
  }
  const integer = (): number => {
    const value = varint()
    return value % 2 ? -(value + 1) / 2 : value / 2
  }
  const skip = (type: number, depth: number): void => {
    if (depth > 8 || ++fields > 512)
      throw new Error('bounded Parquet excessive page-header structure')
    if (type === 1 || type === 2)
      return
    if (type === 3) {
      take(1)
      return
    }
    if (type === 4 || type === 5) {
      varint()
      return
    }
    if (type === 6) {
      for (let i = 0; i < 10; i++) {
        if (!(byte() & 128))
          return
      }
      throw new Error('bounded Parquet invalid header int64')
    }
    if (type === 7) {
      take(8)
      return
    }
    if (type === 8) {
      take(varint())
      return
    }
    if (type === 12) {
      struct(depth + 1)
      return
    }
    // Parquet page headers contain structs/scalars/statistics, not collections.
    throw new Error('bounded Parquet unsupported page-header field')
  }
  function struct(depth: number, select?: (id: number, type: number) => boolean): void {
    let id = 0
    const seen = new Set<number>()
    while (true) {
      const field = byte()
      if (field === 0)
        return
      const type = field & 15
      id = field >> 4 ? id + (field >> 4) : integer()
      if (id < 1 || seen.has(id))
        throw new Error('bounded Parquet invalid page-header field')
      seen.add(id)
      if (!select?.(id, type))
        skip(type, depth)
      if (++fields > 512)
        throw new Error('bounded Parquet excessive page-header fields')
    }
  }
  const root: Record<number, number> = {}
  const children: Record<number, Record<number, number | boolean>> = {}
  struct(0, (id, type) => {
    if ([1, 2, 3].includes(id)) {
      if (type !== 5)
        throw new Error('bounded Parquet invalid page-header number')
      root[id] = integer()
      return true
    }
    if ([5, 7, 8].includes(id)) {
      if (type !== 12)
        throw new Error('bounded Parquet invalid page-header body')
      const body: Record<number, number | boolean> = {}
      children[id] = body
      struct(1, (field, fieldType) => {
        const max = id === 5 ? 4 : id === 7 ? 2 : 7
        if (field > max)
          return false
        if (id === 8 && field === 7) {
          if (fieldType !== 1 && fieldType !== 2)
            throw new Error('bounded Parquet invalid compression boolean')
          body[field] = fieldType === 1
        }
        else {
          if (fieldType !== 5)
            throw new Error('bounded Parquet invalid data-header number')
          body[field] = integer()
        }
        return true
      })
      return true
    }
    return false
  })
  const kind = root[1]!
  const body = children[kind === 0 ? 5 : kind === 2 ? 7 : 8]
  if (![0, 2, 3].includes(kind) || !body)
    throw new Error('bounded Parquet unsupported page type')
  return {
    bytes: offset,
    kind,
    compressed: root[3]!,
    uncompressed: root[2]!,
    count: body[1] as number,
    encoding: body[kind === 3 ? 4 : 2] as number,
    ...(kind === 0 ? { definitionEncoding: body[3] as number, repetitionEncoding: body[4] as number } : {}),
    ...(kind === 3 ? { nulls: body[2] as number, rows: body[3] as number, definitions: body[5] as number, repetitions: body[6] as number, isCompressed: body[7] === undefined ? true : body[7] as boolean } : {}),
  }
}
