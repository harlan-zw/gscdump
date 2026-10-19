import type { SchemaElement } from 'hyparquet'
import { convert, DEFAULT_PARSERS } from 'hyparquet/src/convert.js'

export interface ValueToken { bytes: number, value: () => unknown }
export interface IntegerCursor { next: () => number, finish: () => void }
const utf8 = new TextDecoder()

/** RLE/bit-packed hybrid cursor; no expanded levels or dictionary-ID array. */
export function hybridCursor(bytes: Uint8Array, width: number, count: number): IntegerCursor {
  if (!Number.isInteger(width) || width < 0 || width > 32)
    throw new Error('bounded Parquet invalid bit width')
  let offset = 0
  let remaining = count
  let run = 0
  let repeat = 0
  let packed = false
  let bit = 0
  let packedStart = 0
  const readByte = (): number => {
    if (offset >= bytes.length)
      throw new Error('bounded Parquet truncated RLE stream')
    return bytes[offset++]!
  }
  const next = (): number => {
    if (remaining-- <= 0)
      throw new Error('bounded Parquet too many encoded values')
    if (width === 0 && bytes.length === 0)
      return 0
    if (!run) {
      let header = 0
      let shift = 0
      while (true) {
        const b = readByte()
        header += (b & 127) * 2 ** shift
        if (!(b & 128))
          break
        shift += 7
        if (shift > 28)
          throw new Error('bounded Parquet invalid RLE run')
      }
      packed = !!(header & 1)
      run = packed ? Math.floor(header / 2) * 8 : header / 2
      // DuckDB pads its last bit-packed block to 256 values, not only to eight.
      // Admit that bounded encoded payload, but never expand/visit the padding.
      if (!Number.isSafeInteger(run) || run < 1 || run > 0x7FFFFFFF || (!packed && run > remaining + 1))
        throw new Error(`bounded Parquet invalid RLE run length: run=${run}, remaining=${remaining + 1}, packed=${packed}, width=${width}`)
      if (packed) {
        packedStart = offset
        bit = 0
        offset += run * width / 8
        if (offset > bytes.length)
          throw new Error('bounded Parquet truncated bit-packed stream')
      }
      else {
        repeat = 0
        for (let b = 0; b < Math.ceil(width / 8); b++)
          repeat += readByte() * 2 ** (8 * b)
        if (repeat >= 2 ** width)
          throw new Error('bounded Parquet RLE value exceeds bit width')
      }
    }
    run--
    if (!packed)
      return repeat
    let value = 0
    for (let b = 0; b < width; b++, bit++)
      value += ((bytes[packedStart + Math.floor(bit / 8)]! >> (bit % 8)) & 1) * 2 ** b
    return value
  }
  return { next, finish() {
    if (remaining !== 0 || offset !== bytes.length || (run && !packed))
      throw new Error(`bounded Parquet trailing or incomplete RLE data: remaining=${remaining}, offset=${offset}, bytes=${bytes.length}, run=${run}, packed=${packed}, width=${width}`)
  } }
}

export interface PlainCursor {
  next: () => ValueToken
  skip: () => void
  position: () => number
  finish: () => void
}

/** Lazy PLAIN values; UTF8 conversion happens only after the caller admits a row. */
export function plainCursor(bytes: Uint8Array, element: SchemaElement, count: number, maxValueBytes: number): PlainCursor {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  let index = 0
  const width = element.type === 'BOOLEAN' ? 0 : element.type === 'INT32' || element.type === 'FLOAT' ? 4 : element.type === 'INT96' ? 12 : 8
  const decoder = { element, type: element.type!, parsers: DEFAULT_PARSERS, schemaPath: [] }
  const take = (): { start: number, size: number, index: number } => {
    if (index >= count)
      throw new Error('bounded Parquet too many plain values')
    let size = width
    if (element.type === 'BYTE_ARRAY') {
      if (offset + 4 > bytes.length)
        throw new Error('bounded Parquet truncated string length')
      size = view.getUint32(offset, true)
      offset += 4
      if (size > maxValueBytes)
        throw new RangeError('bounded Parquet exceeds maxValueBytes')
    }
    const start = element.type === 'BOOLEAN' ? Math.floor(index / 8) : offset
    if (start + (element.type === 'BOOLEAN' ? 1 : size) > bytes.length)
      throw new Error('bounded Parquet truncated plain value')
    offset = element.type === 'BOOLEAN' ? Math.ceil((index + 1) / 8) : offset + size
    return { start, size, index: index++ }
  }
  return {
    next() {
      const { start, size, index: bitIndex } = take()
      return { bytes: 64 + (element.type === 'BYTE_ARRAY' ? size * 2 : 32), value() {
        if (element.type === 'BYTE_ARRAY')
          return utf8.decode(bytes.subarray(start, start + size))
        let raw = element.type === 'BOOLEAN'
          ? !!(view.getUint8(start) & 1 << (bitIndex % 8))
          : element.type === 'INT32'
            ? view.getInt32(start, true)
            : element.type === 'INT64'
              ? view.getBigInt64(start, true)
              : element.type === 'INT96'
                ? (BigInt(view.getInt32(start + 8, true)) << 64n) | view.getBigInt64(start, true)
                : element.type === 'FLOAT' ? view.getFloat32(start, true) : view.getFloat64(start, true)
        if (element.type === 'INT64' && (element.converted_type === 'UINT_64' || (element.logical_type?.type === 'INTEGER' && !element.logical_type.isSigned)))
          raw = BigInt.asUintN(64, raw as bigint)
        const result = convert([raw] as never, decoder as never)[0]
        // Match the existing adapter's UTC-component normalization, including
        // non-four-digit years and invalid dates; toISOString() differs there.
        return result instanceof Date
          ? `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`
          : result
      } }
    },
    skip() { take() },
    position: () => offset,
    finish() {
      if (index !== count || offset !== bytes.length)
        throw new Error('bounded Parquet trailing or incomplete plain data')
    },
  }
}
