import type { AsyncBuffer, ColumnMetaData, FileMetaData, SchemaElement } from 'hyparquet'
import type { Row } from '../storage'
import type { BoundedPageHeader } from './parquet-page-header'
import type { IntegerCursor, PlainCursor, ValueToken } from './parquet-value-cursor'
import { snappyUncompress } from 'hyparquet'
import { parquetDecodeBudget } from './parquet-decode-budget'
import { BoundedHeaderTruncatedError, boundedPageHeader } from './parquet-page-header'
import { hybridCursor, plainCursor } from './parquet-value-cursor'

export interface BoundedValuesOptions {
  /** Hard emitted row ceiling, default 1000. */
  targetRows?: number
  /** Conservative UTF16 + row/cell charge before materialization. Default 1 MiB. */
  maxBatchBytes?: number
  /** Maximum encoded bytes of one string, checked before UTF8 conversion. Default 256 KiB. */
  maxValueBytes?: number
  /** Aggregate page/dictionary backing-buffer admission, not total JS heap. Default 24 MiB. */
  maxActiveBytes?: number
  /** Maximum retained page descriptors across the selected input. Default 16384. */
  maxPages?: number
  /** Maximum page header probe. Default 64 KiB. */
  maxHeaderBytes?: number
  /** Maximum entries per dictionary; offsets consume 4 bytes per entry. Default 100000. */
  maxDictionaryEntries?: number
}
export type BoundedValuesPolicy = Required<BoundedValuesOptions>

export function boundedValuesPolicy(options?: BoundedValuesOptions): BoundedValuesPolicy | undefined {
  if (options === undefined)
    return undefined
  const policy = { targetRows: 1000, maxBatchBytes: 1024 * 1024, maxValueBytes: 256 * 1024, maxActiveBytes: 24 * 1024 * 1024, maxPages: 16384, maxHeaderBytes: 64 * 1024, maxDictionaryEntries: 100000, ...options }
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`invalid boundedValues.${key}`)
  }
  return policy
}

interface Page extends BoundedPageHeader { offset: number }
interface ColumnPlan { element: SchemaElement, meta: ColumnMetaData, pages: Page[], dictionary?: Page }
interface GroupPlan { start: number, rows: number, columns: ColumnPlan[], budget?: ReturnType<typeof parquetDecodeBudget> }
const supportedEncodings = new Set([0, 2, 8])

function natural(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || value! < 0)
    throw new Error(`bounded Parquet invalid ${label}`)
  return value!
}

function scalar(element: SchemaElement): boolean {
  if (element.num_children || !['REQUIRED', 'OPTIONAL'].includes(element.repetition_type ?? ''))
    return false
  const converted = element.converted_type
  const logical = element.logical_type?.type
  if (element.type === 'BYTE_ARRAY')
    return (converted === 'UTF8' || logical === 'STRING') && (!converted || converted === 'UTF8') && (!logical || logical === 'STRING')
  return ['BOOLEAN', 'INT32', 'INT64', 'INT96', 'FLOAT', 'DOUBLE'].includes(element.type ?? '')
    && (!converted || ['DATE', 'TIME_MILLIS', 'TIME_MICROS', 'TIMESTAMP_MILLIS', 'TIMESTAMP_MICROS', 'UINT_8', 'UINT_16', 'UINT_32', 'UINT_64', 'INT_8', 'INT_16', 'INT_32', 'INT_64'].includes(converted))
    && (!logical || ['DATE', 'TIME', 'TIMESTAMP', 'INTEGER'].includes(logical))
}

/** All structural/encoding eligibility is checked before any output batch. */
async function readHeader(file: AsyncBuffer, start: number, end: number, maxBytes: number): Promise<BoundedPageHeader> {
  const limit = Math.min(end - start, maxBytes)
  for (let length = Math.min(512, limit); ;) {
    try {
      return boundedPageHeader(await file.slice(start, start + length))
    }
    catch (error) {
      if (!(error instanceof BoundedHeaderTruncatedError) || length === limit)
        throw error
      length = Math.min(limit, length * 2)
    }
  }
}

async function planInput(file: AsyncBuffer, metadata: FileMetaData, policy: BoundedValuesPolicy, maxReadBytes: number, columns?: string[], rowStart = 0, rowEnd = Infinity, maxReadAndDecompressBytes?: number): Promise<GroupPlan[]> {
  const schema = metadata.schema.slice(1)
  if (metadata.schema[0]?.num_children !== schema.length || schema.some(element => !scalar(element)) || new Set(schema.map(element => element.name)).size !== schema.length)
    throw new Error('bounded Parquet requires a flat scalar REQUIRED/OPTIONAL schema')
  const selected = columns ? schema.filter(element => columns.includes(element.name)) : schema
  const output: GroupPlan[] = []
  let start = 0
  let pageCount = 0
  try {
    for (const group of metadata.row_groups) {
      const rows = Number(group.num_rows)
      const plan: GroupPlan = { start, rows, columns: [] }
      start += rows
      if (start <= rowStart || plan.start >= rowEnd)
        continue
      plan.budget = maxReadAndDecompressBytes === undefined ? undefined : parquetDecodeBudget(file, maxReadAndDecompressBytes)
      output.push(plan)
      const groupFile = plan.budget?.file ?? file
      let active = Math.min(policy.maxHeaderBytes, maxReadBytes)
      for (const element of selected) {
        const matches = group.columns.filter(col => col.meta_data?.path_in_schema.length === 1 && col.meta_data.path_in_schema[0] === element.name)
        if (matches.length !== 1)
          throw new Error('bounded Parquet missing or duplicate column')
        const chunk = matches[0]!
        const meta = chunk.meta_data!
        if (chunk.file_path || meta.type !== element.type || Number(meta.num_values) !== rows || !['SNAPPY', 'UNCOMPRESSED'].includes(meta.codec))
          throw new Error('bounded Parquet unsupported column or codec')
        const first = Number(meta.dictionary_page_offset ?? meta.data_page_offset)
        const end = first + Number(meta.total_compressed_size)
        if (!Number.isSafeInteger(first) || first < 4 || !Number.isSafeInteger(end) || end > file.byteLength || end < first)
          throw new Error('bounded Parquet invalid column range')
        const column: ColumnPlan = { element, meta, pages: [] }
        let pageRows = 0
        let maxData = 0
        for (let offset = first; offset < end;) {
          if (++pageCount > policy.maxPages)
            throw new RangeError('bounded Parquet exceeds maxPages')
          const header = await readHeader(groupFile, offset, end, Math.min(policy.maxHeaderBytes, maxReadBytes))
          natural(header.compressed, 'compressed page bytes')
          natural(header.uncompressed, 'uncompressed page bytes')
          natural(header.count, 'page values')
          const page: Page = { ...header, offset: offset + header.bytes }
          offset = page.offset + page.compressed
          if (offset > end || page.compressed > maxReadBytes)
            throw new RangeError('bounded Parquet page exceeds range bounds')
          if (page.kind === 2) {
            if (column.dictionary || column.pages.length || page.encoding !== 0 || page.count > policy.maxDictionaryEntries)
              throw new Error('bounded Parquet unsupported dictionary')
            column.dictionary = page
            // Offset table plus one sentinel. No string/view per dictionary entry.
            active += page.compressed + page.uncompressed + (page.count + 1) * 4
          }
          else {
            if (!page.count || !supportedEncodings.has(page.encoding) || (page.encoding !== 0 && !column.dictionary))
              throw new Error('bounded Parquet unsupported data encoding')
            if (page.kind === 0 && (page.definitionEncoding !== 3 || page.repetitionEncoding !== 3))
              throw new Error('bounded Parquet unsupported level encoding')
            if (page.kind === 3) {
              natural(page.nulls, 'null count')
              natural(page.rows, 'page rows')
              natural(page.definitions, 'definition bytes')
              natural(page.repetitions, 'repetition bytes')
              if (page.rows !== page.count || page.nulls! > page.count || page.repetitions !== 0 || page.definitions! > page.compressed || page.definitions! > page.uncompressed
                || (element.repetition_type === 'REQUIRED' && (page.definitions !== 0 || page.nulls !== 0))) {
                throw new Error('bounded Parquet invalid flat V2 page')
              }
            }
            pageRows += page.count
            if (pageRows > rows)
              throw new Error('bounded Parquet excess physical rows')
            maxData = Math.max(maxData, page.compressed + page.uncompressed)
            column.pages.push(page)
          }
        }
        if (pageRows !== rows)
          throw new Error('bounded Parquet incomplete physical rows')
        if (column.dictionary && element.type === 'BOOLEAN')
          throw new Error('bounded Parquet BOOLEAN dictionary is unsupported')
        active += maxData
        if (!Number.isSafeInteger(active) || active > policy.maxActiveBytes)
          throw new RangeError('bounded Parquet exceeds maxActiveBytes')
        plan.columns.push(column)
      }
    }
    return output
  }
  catch (error) {
    for (const plan of output)
      plan.budget?.close()
    throw error
  }
}

type Decompress = (input: Uint8Array, size: number) => Uint8Array

function inflate(input: Uint8Array, size: number, compressed: boolean, decompress?: Decompress): Uint8Array {
  if (!compressed) {
    if (input.length !== size)
      throw new Error('bounded Parquet uncompressed page size mismatch')
    return input
  }
  if (decompress)
    return decompress(input, size)
  const output = new Uint8Array(size)
  snappyUncompress(input, output)
  return output
}

interface RowCursor { next: () => ValueToken, finish: () => void }

function dataCursor(page: Page, input: Uint8Array, plan: ColumnPlan, policy: BoundedValuesPolicy, dictionary?: { bytes: Uint8Array, offsets: Uint32Array }, decompress?: Decompress): RowCursor {
  let definitions: IntegerCursor | undefined
  let levels: Uint8Array | undefined
  let values: Uint8Array
  if (page.kind === 0) {
    const decoded = inflate(input, page.uncompressed, plan.meta.codec === 'SNAPPY', decompress)
    let offset = 0
    if (plan.element.repetition_type === 'OPTIONAL') {
      if (decoded.length < 4)
        throw new Error('bounded Parquet missing definition levels')
      const length = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength).getUint32(0, true)
      offset = 4 + length
      if (offset > decoded.length)
        throw new Error('bounded Parquet truncated definition levels')
      levels = decoded.subarray(4, offset)
    }
    values = decoded.subarray(offset)
  }
  else {
    const length = page.definitions!
    if (plan.element.repetition_type === 'OPTIONAL')
      levels = input.subarray(0, length)
    values = inflate(input.subarray(length), page.uncompressed - length, page.isCompressed !== false && plan.meta.codec === 'SNAPPY', decompress)
  }
  // Count nulls with a small independent level cursor, without materialization.
  // Recreate only its scalar state for the actual row cursor.
  let present = page.count
  if (levels) {
    definitions = hybridCursor(levels, 1, page.count)
    present = 0
    for (let i = 0; i < page.count; i++)
      present += definitions.next()
    definitions.finish()
    definitions = hybridCursor(levels, 1, page.count)
  }
  if (page.kind === 3 && page.count - present !== page.nulls)
    throw new Error('bounded Parquet null count mismatch')
  let plain: PlainCursor | undefined
  let ids: IntegerCursor | undefined
  if (page.encoding === 0) {
    plain = plainCursor(values, plan.element, present, policy.maxValueBytes)
  }
  else {
    if (!dictionary || !values.length)
      throw new Error('bounded Parquet missing dictionary IDs')
    ids = hybridCursor(values.subarray(1), values[0]!, present)
  }
  return {
    next() {
      if (definitions && definitions.next() === 0)
        return { bytes: 64, value: () => null }
      if (plain)
        return plain.next()
      const id = ids!.next()
      if (id >= dictionary!.offsets.length - 1)
        throw new Error('bounded Parquet dictionary ID out of range')
      const start = dictionary!.offsets[id]!
      const end = dictionary!.offsets[id + 1]!
      // BOOLEAN dictionaries are uncommon and explicitly refused below because
      // entries share bytes; other PLAIN scalars/UTF8 are independently sliced.
      return plainCursor(dictionary!.bytes.subarray(start, end), plan.element, 1, policy.maxValueBytes).next()
    },
    finish() {
      definitions?.finish()
      plain?.finish()
      ids?.finish()
    },
  }
}

class ColumnCursor {
  private dictionary?: { bytes: Uint8Array, offsets: Uint32Array }
  private current?: RowCursor
  private pageIndex = 0
  private remaining = 0
  constructor(private file: AsyncBuffer, private plan: ColumnPlan, private policy: BoundedValuesPolicy, private decompress?: Decompress) {}

  needsPage(): boolean { return this.remaining === 0 }

  async load(): Promise<void> {
    if (this.remaining)
      return
    this.current?.finish()
    this.current = undefined
    if (!this.dictionary && this.plan.dictionary) {
      const page = this.plan.dictionary
      const input = new Uint8Array(await this.file.slice(page.offset, page.offset + page.compressed))
      const bytes = inflate(input, page.uncompressed, this.plan.meta.codec === 'SNAPPY', this.decompress)
      const offsets = new Uint32Array(page.count + 1)
      const cursor = plainCursor(bytes, this.plan.element, page.count, this.policy.maxValueBytes)
      for (let index = 0; index < page.count; index++) {
        offsets[index] = cursor.position()
        cursor.skip()
      }
      offsets[page.count] = cursor.position()
      cursor.finish()
      this.dictionary = { bytes, offsets }
    }
    const page = this.plan.pages[this.pageIndex++]
    if (!page)
      throw new Error('bounded Parquet exhausted column')
    const input = new Uint8Array(await this.file.slice(page.offset, page.offset + page.compressed))
    this.current = dataCursor(page, input, this.plan, this.policy, this.dictionary, this.decompress)
    this.remaining = page.count
  }

  next(): ValueToken {
    if (!this.current || this.remaining-- < 1)
      throw new Error('bounded Parquet column is not ready')
    return this.current.next()
  }

  close(): void {
    this.current = undefined
    this.dictionary = undefined
  }

  finish(): void {
    this.current?.finish()
    if (this.remaining || this.pageIndex !== this.plan.pages.length)
      throw new Error('bounded Parquet incomplete column')
  }
}

export async function* decodeBoundedValues(file: AsyncBuffer, metadata: FileMetaData, policy: BoundedValuesPolicy, maxReadBytes: number, options: { columns?: string[], rowStart?: number, rowEnd?: number }, maxReadAndDecompressBytes?: number): AsyncGenerator<Row[]> {
  const plans = await planInput(file, metadata, policy, maxReadBytes, options.columns, options.rowStart, options.rowEnd, maxReadAndDecompressBytes)
  try {
    for (const plan of plans) {
      const budget = plan.budget
      const cursors = plan.columns.map(column => new ColumnCursor(budget?.file ?? file, column, policy, budget?.compressors.SNAPPY))
      let batch: Row[] = []
      let batchBytes = 0
      try {
        for (let index = 0; index < plan.rows; index++) {
        // Only await at page boundaries; no per-value promise/generator layers.
          for (const cursor of cursors) {
            if (cursor.needsPage())
              await cursor.load()
          }
          const tokens = cursors.map(cursor => cursor.next())
          const position = plan.start + index
          if (position < (options.rowStart ?? 0) || position >= (options.rowEnd ?? Infinity))
            continue
          const bytes = 128 + tokens.reduce((sum, token) => sum + 16 + token.bytes, 0)
          if (bytes > policy.maxBatchBytes)
            throw new RangeError('bounded Parquet row exceeds maxBatchBytes')
          if (batch.length && (batch.length >= policy.targetRows || batchBytes + bytes > policy.maxBatchBytes)) {
            yield batch
            batch = []
            batchBytes = 0
          }
          const row: Row = {}
          for (let col = 0; col < tokens.length; col++)
            Object.defineProperty(row, plan.columns[col]!.element.name, { value: tokens[col]!.value(), enumerable: true, configurable: true, writable: true })
          batch.push(row)
          batchBytes += bytes
        }
        for (const cursor of cursors)
          cursor.finish()
        if (batch.length)
          yield batch
      }
      finally {
        for (const cursor of cursors)
          cursor.close()
        budget?.close()
      }
    }
  }
  finally {
    for (const plan of plans)
      plan.budget?.close()
  }
}
